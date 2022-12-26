const _ = require('lodash');
const AWSXRay = require('aws-xray-sdk');

const constants = require('../../constants');
const getPipelineStatus = require('./getPipelineStatus');
const { createGem2SPipeline, createQCPipeline } = require('./pipelineConstruct');

const Sample = require('../../model/Sample');
const Experiment = require('../../model/Experiment');
const ExperimentExecution = require('../../model/ExperimentExecution');

const sendNotification = require('./hooks/sendNotification');
const HookRunner = require('./hooks/HookRunner');

const validateRequest = require('../../../utils/schema-validator');
const getLogger = require('../../../utils/getLogger');
const { MethodNotAllowedError } = require('../../../utils/responses');

const logger = getLogger('[Gem2sService] - ');

const hookRunner = new HookRunner();

/**
 *
 * @param {*} experimentId
 * @param {*} processingConfig The full processing config for an experiment
 * @returns A copy of processingConfig with each filterSettings entry
 *  duplicated under defaultFilterSettings
 */
const addDefaultFilterSettings = (experimentId, processingConfig) => {
  const processingConfigToReturn = _.cloneDeep(processingConfig);

  logger.log('Adding defaultFilterSettings to received processing config');

  const stepsToDuplicate = [
    'cellSizeDistribution',
    'mitochondrialContent',
    'classifier',
    'numGenesVsNumUmis',
    'doubletScores',
  ];

  stepsToDuplicate.forEach((stepName) => {
    const stepConfigSplitBySample = Object.values(processingConfigToReturn[stepName]);

    stepConfigSplitBySample.forEach((sampleSettings) => {
      if (!sampleSettings.filterSettings) {
        logger.log(`Experiment: ${experimentId}. Skipping current sample config, it doesnt have filterSettings:`);
        logger.log(JSON.stringify(sampleSettings.filterSettings));
        return;
      }

      // eslint-disable-next-line no-param-reassign
      sampleSettings.defaultFilterSettings = _.cloneDeep(sampleSettings.filterSettings);
    });
  });

  logger.log('Finished adding defaultFilterSettings to received processing config');

  return processingConfigToReturn;
};

const continueToQC = async (payload) => {
  const { experimentId, item, jobId } = payload;

  // Before persisting the new processing config,
  // fill it in with default filter settings (to preserve the gem2s-generated settings)
  const processingConfigWithDefaults = addDefaultFilterSettings(
    experimentId, item.processingConfig,
  );

  await new Experiment().updateById(
    experimentId, { processing_config: processingConfigWithDefaults },
  );

  logger.log(`Experiment: ${experimentId}. Saved processing config received from gem2s`);

  logger.log(`Experiment: ${experimentId}. Starting qc run because gem2s finished successfully`);

  logger.log(`continueToQc: previous jobId: ${jobId}`);

  // we need to change this once we rework the pipeline message response
  const authJWT = payload.authJWT || payload.input.authJWT;

  await createQCPipeline(experimentId, [], authJWT, jobId);

  logger.log('Started qc successfully');
};

/**
 *
 * Works with the subsetSeurat sns notification, it adds to sql
 * the samples that were just duplicated
 *
 * Within payload, takes a sampleIdMap object with:
 * - keys: ids of parent experiment samples that survived the subset
 * - values: ids of corresponding subset experiment samples
 *
 * @param {*} payload
 *
 */
const setupSubsetSamples = async (payload) => {
  const { sampleIdMap, input: { parentExperimentId, subsetExperimentId } } = payload;

  const {
    samplesOrder: parentSamplesOrder,
  } = await new Experiment().findById(parentExperimentId).first();

  const samplesToCloneIds = parentSamplesOrder.filter((id) => sampleIdMap[id]);

  logger.log(`Cloning retained experiment samples from experiment ${parentExperimentId} into subset: ${subsetExperimentId}`);

  const cloneSamplesOrder = await new Sample().copyTo(
    parentExperimentId, subsetExperimentId, samplesToCloneIds,
  );

  await new Experiment().updateById(
    subsetExperimentId,
    { samples_order: JSON.stringify(cloneSamplesOrder) },
  );

  logger.log(`Finished creating samples for new subset experiment: ${subsetExperimentId}`);
  // Add samples that were created
};

hookRunner.register('uploadToAWS', [continueToQC]);
hookRunner.register('subsetSeurat', [setupSubsetSamples]);

hookRunner.registerAll([sendNotification]);

const sendUpdateToSubscribed = async (experimentId, message, io) => {
  const statusRes = await getPipelineStatus(experimentId, constants.GEM2S_PROCESS_NAME);

  // Concatenate into a proper response.
  const response = {
    ...message,
    status: statusRes,
    type: constants.GEM2S_PROCESS_NAME,
  };

  const { error = null } = message.response || {};
  if (error) {
    logger.log(`Error in ${constants.GEM2S_PROCESS_NAME} received`);
    AWSXRay.getSegment().addError(error);
  }

  logger.log('Sending to all clients subscribed to experiment', experimentId);

  io.sockets.emit(`ExperimentUpdates-${experimentId}`, response);
};

const generateGem2sParams = async (experimentId, authJWT) => {
  const defaultMetadataValue = 'N.A.';

  logger.log('Generating gem2s params');

  const getS3Paths = (files) => {
    const s3Paths = {};
    Object.keys(files).forEach((key) => {
      s3Paths[key] = files[key].s3Path;
    });
    return s3Paths;
  };

  const [experiment, samples] = await Promise.all([
    new Experiment().findById(experimentId).first(),
    new Sample().getSamples(experimentId),
  ]);

  if (!experiment.canRerunGem2s) {
    throw new MethodNotAllowedError(`Experiment ${experimentId} can't run gem2s`);
  }

  const samplesInOrder = experiment.samplesOrder.map(
    (sampleId) => _.find(samples, { id: sampleId }),
  );

  const s3Paths = {};
  const sampleOptions = {};

  experiment.samplesOrder.forEach((sampleId) => {
    const { files, options } = _.find(samples, { id: sampleId });

    s3Paths[sampleId] = getS3Paths(files);
    sampleOptions[sampleId] = options || {};
  });

  const taskParams = {
    projectId: experimentId,
    experimentName: experiment.name,
    organism: null,
    input: { type: samples[0].sampleTechnology },
    sampleIds: experiment.samplesOrder,
    sampleNames: _.map(samplesInOrder, 'name'),
    sampleS3Paths: s3Paths,
    sampleOptions,
    authJWT,
  };

  const metadataKeys = Object.keys(samples[0].metadata);

  if (metadataKeys.length) {
    logger.log('Adding metadatakeys to task params');

    taskParams.metadata = metadataKeys.reduce((acc, key) => {
      // Make sure the key does not contain '-' as it will cause failure in GEM2S
      const sanitizedKey = key.replace(/-+/g, '_');

      acc[sanitizedKey] = Object.values(samplesInOrder).map(
        (sampleValue) => sampleValue.metadata[key] || defaultMetadataValue,
      );

      return acc;
    }, {});
  }

  logger.log('Task params generated');

  return taskParams;
};

const startGem2sPipeline = async (experimentId, body, authJWT) => {
  logger.log('Creating GEM2S params...');
  const { paramsHash } = body;

  const taskParams = await generateGem2sParams(experimentId, authJWT);

  const { stateMachineArn, executionArn } = await createGem2SPipeline(experimentId, taskParams);

  logger.log('GEM2S params created.');

  const newExecution = {
    params_hash: paramsHash,
    state_machine_arn: stateMachineArn,
    execution_arn: executionArn,
  };

  const experimentExecutionClient = new ExperimentExecution();

  await experimentExecutionClient.upsert(
    {
      experiment_id: experimentId,
      pipeline_type: 'gem2s',
    },
    newExecution,
  );

  await experimentExecutionClient.delete({
    experiment_id: experimentId,
    pipeline_type: 'qc',
  });

  logger.log('GEM2S params saved.');

  return newExecution;
};

const handleGem2sResponse = async (io, message) => {
  AWSXRay.getSegment().addMetadata('message', message);

  // Fail hard if there was an error.
  await validateRequest(message, 'GEM2SResponse.v2.yaml');

  await hookRunner.run(message);

  const { experimentId } = message;

  const messageForClient = _.cloneDeep(message);

  // If we are at uploadToAWS, then a new processingConfig was received
  // Before being returned to the client we need to
  // fill it in with default filter settings (to preserve the gem2s-generated settings)
  if (messageForClient.taskName === 'uploadToAWS') {
    messageForClient.item.processingConfig = addDefaultFilterSettings(
      experimentId,
      messageForClient.item.processingConfig,
    );
  }

  // Make sure authJWT doesn't get back to the client
  delete messageForClient.authJWT;
  delete messageForClient.input.authJWT;

  await sendUpdateToSubscribed(experimentId, messageForClient, io);
};

module.exports = {
  startGem2sPipeline,
  handleGem2sResponse,
};
