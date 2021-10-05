const _ = require('lodash');
const AWSXRay = require('aws-xray-sdk');

const validateRequest = require('../../utils/schema-validator');
const AWS = require('../../utils/requireAWS');
const getLogger = require('../../utils/getLogger');
const { assignPodToPipeline } = require('../../utils/hooks/pipeline-assign');
const constants = require('../general-services/pipeline-manage/constants');
const getPipelineStatus = require('../general-services/pipeline-status');

const ExperimentService = require('./experiment');
const PlotsTablesService = require('./plots-tables');
const PipelineHook = require('../../utils/hookRunner');

const plotsTableService = new PlotsTablesService();
const experimentService = new ExperimentService();

const logger = getLogger();


const pipelineHook = new PipelineHook();

pipelineHook.register(constants.ASSIGN_POD_TO_PIPELINE, [assignPodToPipeline]);

class PipelineService {
  static async getS3Output(message) {
    const { output: { bucket, key } } = message;
    const s3 = new AWS.S3();
    const outputObject = await s3.getObject(
      {
        Bucket: bucket,
        Key: key,
      },
    ).promise();

    return JSON.parse(outputObject.Body.toString());
  }

  static async updatePlotData(taskName, experimentId, output) {
    if (output.plotDataKeys) {
      const plotConfigUploads = Object.entries(output.plotDataKeys).map(([plotUuid, objKey]) => (
        plotsTableService.updatePlotDataKey(
          experimentId,
          plotUuid,
          objKey,
        )
      ));

      logger.log('Uploading plotData for', taskName, 'to DynamoDB');

      // Promise.all stops if it encounters errors.
      // This handles errors so that error in one upload does not stop others
      // Resulting promise resolves to an array with the resolve/reject value of p
      Promise.all(plotConfigUploads.map((p) => p.catch((e) => e)));
    }
  }

  static async updateProcessingConfig(taskName, experimentId, output, sampleUuid) {
    console.log(output.config);
    if (!output.config) {
      return;
    }

    await validateRequest(output.config, 'ProcessingConfigBodies.v1.yaml');

    const {
      processingConfig: previousConfig,
    } = await experimentService.getProcessingConfig(experimentId);


    // TODO check that this can indeed be removed
    // const { auto } = output.config;
    // This is a temporary fix to save defaultFilterSettings calculated in the QC pipeline
    // to patch for old experiments with hardcoded defaultFilterSettings.
    // Remove this once we're done migrating to the new experiment schema with defaultFilterSettings
    // if (auto) output.config.defaultFilterSettings = output.config.filterSettings;

    await experimentService.updateProcessingConfig(experimentId, [
      {
        name: taskName,
        body: {
          ...previousConfig[taskName],
          [sampleUuid]: { ...output.config },
        },
      },
    ]);
  }

  static async sendUpdateToSubscribed(experimentId, message, output, io) {
    const statusRes = await getPipelineStatus(experimentId, constants.QC_PROCESS_NAME);
    const statusResToSend = { pipeline: statusRes[constants.QC_PROCESS_NAME] };

    // Concatenate into a proper response.
    const response = {
      ...message,
      status: statusResToSend,
      type: constants.GEM2S_PROCESS_NAME,
    };

    if (output !== null) {
      response.output = output;
    }

    const { error = null } = message.response || {};

    if (error) {
      logger.log(`Error in ${constants.QC_PROCESS_NAME} received`);

      AWSXRay.getSegment().addError(error);
    }

    logger.log('Sending to all clients subscribed to experiment', experimentId);
    io.sockets.emit(`ExperimentUpdates-${experimentId}`, response);
  }

  static async qcResponse(io, message) {
    AWSXRay.getSegment().addMetadata('message', message);

    await validateRequest(message, 'PipelineResponse.v1.yaml');

    await pipelineHook.run(message);

    const { taskName, experimentId } = message;

    let output = null;

    // if there is output to be uploaded to s3 and TODO
    if ('output' in message) {
      const { input: { sampleUuid } } = message;

      output = await this.getS3Output(message);

      await this.updatePlotData(taskName, experimentId, output);

      await this.updateProcessingConfig(taskName, experimentId, output, sampleUuid);
    }

    // Ask Martin why this deep clone
    const messageForClient = _.cloneDeep(message);

    await this.sendUpdateToSubscribed(experimentId, messageForClient, output, io);
  }
}

module.exports = PipelineService;
