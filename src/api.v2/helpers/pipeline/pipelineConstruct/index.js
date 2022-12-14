const _ = require('lodash');
const util = require('util');

const config = require('../../../../config');
const {
  QC_PROCESS_NAME, GEM2S_PROCESS_NAME, SUBSET_PROCESS_NAME,
} = require('../../../constants');

const Experiment = require('../../../model/Experiment');
const ExperimentExecution = require('../../../model/ExperimentExecution');

const getLogger = require('../../../../utils/getLogger');

const {
  getGem2sPipelineSkeleton, getQcPipelineSkeleton, getSubsetPipelineSkeleton,
} = require('./skeletons');
const { getQcStepsToRun, qcStepsWithFilterSettings } = require('./qcHelpers');
const needsBatchJob = require('../batch/needsBatchJob');

const {
  executeStateMachine,
  createActivity,
  createNewStateMachine,
  cancelPreviousPipelines,
  getGeneralPipelineContext,
} = require('./utils');

const buildStateMachineDefinition = require('./constructors/buildStateMachineDefinition');

const logger = getLogger();

/**
 *
 * @param {*} processingConfig The processing config with defaultFilterSettings in each step
 * @param {*} samplesOrder The sample ids to iterate over
 * @returns The processing config without defaultFilterSettings in each step
 */
const withoutDefaultFilterSettings = (processingConfig, samplesOrder) => {
  const slimmedProcessingConfig = _.cloneDeep(processingConfig);

  qcStepsWithFilterSettings.forEach((stepName) => {
    samplesOrder.forEach((sampleId) => {
      delete slimmedProcessingConfig[stepName][sampleId].defaultFilterSettings;
    });
  });

  return slimmedProcessingConfig;
};

const createQCPipeline = async (experimentId, processingConfigUpdates, authJWT, previousJobId) => {
  logger.log(`createQCPipeline: fetch processing settings ${experimentId}`);

  const { processingConfig, samplesOrder } = await new Experiment().findById(experimentId).first();

  if (processingConfigUpdates.length) {
    processingConfigUpdates.forEach(({ name, body }) => {
      if (!processingConfig[name]) {
        processingConfig[name] = body;

        return;
      }

      _.assign(processingConfig[name], body);
    });
  }

  const context = {
    ...(await getGeneralPipelineContext(experimentId, QC_PROCESS_NAME)),
    processingConfig: withoutDefaultFilterSettings(processingConfig, samplesOrder),
    authJWT,
  };

  await cancelPreviousPipelines(experimentId, previousJobId);

  const qcSteps = await getQcStepsToRun(experimentId, processingConfigUpdates);

  const runInBatch = needsBatchJob(context.podCpus, context.podMemory);

  const qcPipelineSkeleton = await getQcPipelineSkeleton(
    config.clusterEnv,
    qcSteps,
    runInBatch,
  );

  logger.log('Skeleton constructed, now building state machine definition...');

  const stateMachine = buildStateMachineDefinition(qcPipelineSkeleton, context);
  logger.log('State machine definition built, now creating activity if not already present...');

  const activityArn = await createActivity(context); // the context contains the activityArn
  logger.log(`Activity with ARN ${activityArn} created, now creating state machine from skeleton...`);

  const stateMachineArn = await createNewStateMachine(context, stateMachine, QC_PROCESS_NAME);
  logger.log(`State machine with ARN ${stateMachineArn} created, launching it...`);
  logger.log('Context:', util.inspect(context, { showHidden: false, depth: null, colors: false }));
  logger.log('State machine:', util.inspect(stateMachine, { showHidden: false, depth: null, colors: false }));

  const execInput = {
    samples: samplesOrder.map((sampleUuid, index) => ({ sampleUuid, index })),
  };

  const executionArn = await executeStateMachine(stateMachineArn, execInput);
  logger.log(`Execution with ARN ${executionArn} created.`);

  await new ExperimentExecution().upsert(
    {
      experiment_id: experimentId,
      pipeline_type: 'qc',
    },
    {
      state_machine_arn: stateMachineArn,
      execution_arn: executionArn,
    },
  );
};

const createGem2SPipeline = async (experimentId, taskParams, authJWT) => {
  const context = {
    ...(await getGeneralPipelineContext(experimentId, GEM2S_PROCESS_NAME)),
    processingConfig: {},
    taskParams,
    authJWT,
  };

  await cancelPreviousPipelines(experimentId);

  const runInBatch = needsBatchJob(context.podCpus, context.podMemory);

  const gem2sPipelineSkeleton = getGem2sPipelineSkeleton(config.clusterEnv, runInBatch);
  logger.log('Skeleton constructed, now building state machine definition...');

  const stateMachine = buildStateMachineDefinition(gem2sPipelineSkeleton, context);
  logger.log('State machine definition built, now creating activity if not already present...');

  const activityArn = await createActivity(context);
  logger.log(`Activity with ARN ${activityArn} created, now creating state machine from skeleton...`);

  const stateMachineArn = await createNewStateMachine(context, stateMachine, GEM2S_PROCESS_NAME);
  logger.log(`State machine with ARN ${stateMachineArn} created, launching it...`);
  logger.log('Context:', util.inspect(context, { showHidden: false, depth: null, colors: false }));
  logger.log('State machine:', util.inspect(stateMachine, { showHidden: false, depth: null, colors: false }));

  const executionArn = await executeStateMachine(stateMachineArn);
  logger.log(`Execution with ARN ${executionArn} created.`);

  return { stateMachineArn, executionArn };
};

const createSubsetPipeline = async (
  fromExperimentId, toExperimentId, toExperimentName, cellSetKeys, authJWT,
) => {
  const stepsParams = {
    parentExperimentId: fromExperimentId,
    subsetExperimentId: toExperimentId,
    cellSetKeys,
  };

  // None of the other normal gem2s params are necessary for these 2 steps
  const lastStepsParams = { experimentName: toExperimentName, authJWT };

  const context = {
    ...(await getGeneralPipelineContext(toExperimentId, SUBSET_PROCESS_NAME)),
    taskParams: {
      subsetSeurat: stepsParams,
      prepareExperiment: lastStepsParams,
      uploadToAWS: lastStepsParams,
    },
  };

  // Don't allow gem2s, qc runs doing changes on the data we need to perform the subset
  // This also cancels other subset pipeline runs on the same from experiment,
  //  need to check if that is fine
  await cancelPreviousPipelines(fromExperimentId);

  const runInBatch = needsBatchJob(context.podCpus, context.podMemory);

  const subsetPipelineSkeleton = getSubsetPipelineSkeleton(config.clusterEnv, runInBatch);
  logger.log('Skeleton constructed, now building state machine definition...');

  const stateMachine = buildStateMachineDefinition(subsetPipelineSkeleton, context);
  logger.log('State machine definition built, now creating activity if not already present...');

  const activityArn = await createActivity(context);
  logger.log(`Activity with ARN ${activityArn} created, now creating state machine from skeleton...`);

  const stateMachineArn = await createNewStateMachine(context, stateMachine, SUBSET_PROCESS_NAME);
  logger.log(`State machine with ARN ${stateMachineArn} created, launching it...`);
  logger.log('Context:', util.inspect(context, { showHidden: false, depth: null, colors: false }));
  logger.log('State machine:', util.inspect(stateMachine, { showHidden: false, depth: null, colors: false }));

  const executionArn = await executeStateMachine(stateMachineArn);
  logger.log(`Execution with ARN ${executionArn} created.`);

  return { stateMachineArn, executionArn };
};


module.exports = {
  createQCPipeline,
  createGem2SPipeline,
  createSubsetPipeline,
  buildStateMachineDefinition,
};
