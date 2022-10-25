/* eslint-disable no-await-in-loop */
const k8s = require('@kubernetes/client-node');
const getLogger = require('../../../../utils/getLogger');
const validateRequest = require('../../../../utils/schema-validator');
const constants = require('../../../constants');
const { deleteExperimentPods } = require('./podCleanup');

const logger = getLogger();

const kc = new k8s.KubeConfig();
kc.loadFromDefault();

const formatError = (error) => {
  // if we have a kubernetes error, get the response message because
  // the default error message (e.message) is not useful
  if (error.statusCode && error.response && error.response.body) {
    return `${error.statusCode}: ${error.response.body.message}`;
  }
  return error;
};
// getAvailablePods retrieves pods not assigned already to an activityID given a selector
const getAvailablePods = async (namespace, statusSelector) => {
  const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

  const pods = await k8sApi.listNamespacedPod(namespace, null, null, null, statusSelector, '!activityId,type=pipeline');
  return pods.body.items;
};


const patchPod = async (message) => {
  const k8sApi = kc.makeApiClient(k8s.CoreV1Api);

  const { experimentId, input: { sandboxId, activityId, processName } } = message;
  const namespace = `pipeline-${sandboxId}`;

  // try to get an available pod which is already running
  let pods = await getAvailablePods(namespace, 'status.phase=Running');
  if (pods.length < 1) {
    logger.log(`patchPod: no running pods available in ${namespace}`);
    pods = await getAvailablePods(namespace, 'status.phase=ContainerCreating');
  }
  if (pods.length < 1) {
    logger.log(`patchPod: no pods in creation process available in ${namespace}`);
    pods = await getAvailablePods(namespace, 'status.phase=Pending');
  }

  if (pods.length < 1) {
    throw new Error(`patchPod: no unassigned pods available in ${namespace}`);
  }

  logger.log(`patchPod: ${pods.length} unassigned candidate pods found`);

  // Select a pod to run this experiment on.
  const selectedPod = parseInt(experimentId, 16) % pods.length;
  const { name } = pods[selectedPod].metadata;

  const patch = [
    { op: 'test', path: '/metadata/labels/activityId', value: null },
    {
      op: 'add', path: '/metadata/labels/activityId', value: activityId,
    },
    {
      op: 'add', path: '/metadata/labels/experimentId', value: experimentId,
    },
    {
      op: 'add', path: '/metadata/labels/processName', value: processName,
    },
  ];

  await k8sApi.patchNamespacedPod(name, namespace, patch,
    undefined, undefined, undefined, undefined,
    {
      headers: {
        'content-type': 'application/json-patch+json',
      },
    });

  logger.log(`patchPod: assigned ${selectedPod} ${name} to ${experimentId}`);
};

const assignPodToPipeline = async (message) => {
  // this checks should be refactored and cleaned once the gem2s / qc spec refactors are done
  // and we can be sure that taskName is always present at the top-level of all the message
  // instead of inside input

  if (message && message.taskName !== constants.ASSIGN_POD_TO_PIPELINE) {
    return;
  }

  // validate that the message contains input
  await validateRequest(message, 'PipelinePodRequest.v2.yaml');

  const { experimentId, input: { sandboxId, activityId, processName } } = message;

  logger.log(`Trying to assign ${processName} pod to experiment ${experimentId} in sandbox ${sandboxId} for activity ${activityId}`);


  try {
    // remove pipeline pods already assigned to this experiment
    await deleteExperimentPods(experimentId);
  } catch (e) {
    logger.error(`Failed to remove pods for experiment ${experimentId}. ${formatError(e)}`);
  }

  try {
    // try to choose a free pod and assign it to the current pipeline
    await patchPod(message);
  } catch (e) {
    logger.error(`Failed to assign pipeline pod to experiment ${experimentId}: ${formatError(e)}`);
  }
};

module.exports = assignPodToPipeline;
