const config = require('../../config');
const {
  createDynamoDbInstance, convertToDynamoDbRecord, convertToJsObject,
} = require('../../utils/dynamoDb');
const getLogger = require('../../utils/getLogger');

const { OK, NotFoundError } = require('../../utils/responses');
const safeBatchGetItem = require('../../utils/safeBatchGetItem');

const SamplesService = require('./samples');
const ExperimentService = require('./experiment');
const AccessService = require('./access');

const logger = getLogger();

const samplesService = new SamplesService();
const experimentService = new ExperimentService();
const accessService = new AccessService();

class ProjectsService {
  constructor() {
    this.projectsTableName = `projects-${config.clusterEnv}`;
    this.samplesTableName = `samples-${config.clusterEnv}`;
  }

  async getProject(projectUuid) {
    logger.log(`Getting project item with id ${projectUuid}`);
    const marshalledKey = convertToDynamoDbRecord({
      projectUuid,
    });

    const params = {
      TableName: this.projectsTableName,
      Key: marshalledKey,
    };

    const dynamodb = createDynamoDbInstance();
    const response = await dynamodb.getItem(params).promise();
    if (response.Item) {
      const prettyResponse = convertToJsObject(response.Item);
      return prettyResponse.projects;
    }

    logger.log(`Project ${projectUuid} not found`);
    return response;
  }

  async createProject(projectUuid, project) {
    logger.log(`Creating project with id ${projectUuid}`);

    const experimentId = project.experiments[0];

    await Promise.all([
      this.createEmptySamplesEntry(projectUuid, experimentId),
      this.updateProject(projectUuid, project),
    ]);

    return OK();
  }

  async updateProject(projectUuid, project) {
    logger.log(`Updating project with id ${projectUuid}`);
    const marshalledKey = convertToDynamoDbRecord({
      projectUuid,
    });

    const marshalledData = convertToDynamoDbRecord({
      ':project': project,
    });

    const params = {
      TableName: this.projectsTableName,
      Key: marshalledKey,
      UpdateExpression: 'SET projects = :project',
      ExpressionAttributeValues: marshalledData,
    };

    const dynamodb = createDynamoDbInstance();

    await dynamodb.updateItem(params).promise();

    return OK();
  }

  /**
   * Finds all projects referenced in experiments.
   */
  async getProjects(user) {
    if (!user) {
      return [];
    }

    // Get project data from the experiments table. Only return
    // those tables that have a project ID associated with them.
    const params = {
      TableName: experimentService.experimentsTableName,
      FilterExpression: 'attribute_exists(projectId) and contains(#rbac_can_write, :userId)',
      ExpressionAttributeNames: {
        '#pid': 'projectId',
        '#rbac_can_write': 'rbac_can_write',
      },
      ExpressionAttributeValues: {
        ':userId': { S: user.sub },
      },
      ProjectionExpression: '#pid',
    };

    const dynamodb = createDynamoDbInstance();

    let response = await dynamodb.scan(params).promise();

    const extractProjectIds = (resp) => resp.Items.map(
      (entry) => convertToJsObject(entry).projectId,
    ).filter((id) => id);

    let projectIds = extractProjectIds(response);

    // Check if query exceeds limit
    while (response.LastEvaluatedKey) {
      params.ExclusiveStartKey = response.LastEvaluatedKey;

      // eslint-disable-next-line no-await-in-loop
      response = await dynamodb.scan(params).promise();

      const newProjectIds = extractProjectIds(response);

      projectIds = projectIds.concat(newProjectIds);
    }

    // Remove duplicates (when we support multi experiment projects
    // we might have repeated projectId's)
    projectIds = [...new Set(projectIds)];

    return await this.getProjectsFromIds(projectIds);
  }

  // TODO replace getProjects when migrating to new permissions model
  /**
   * Finds all accessible projects of a user
   */
  async getProjectsNew(user) {
    const projectIds = await accessService.getAccessibleProjects(user.sub);

    return await this.getProjectsFromIds(projectIds);
  }

  /**
   * Returns information about a group of projects.
   *
   * @param {Array} projectIds A Array of projectId values that are to be queried.
   * @returns An object containing descriptions of projects.
   */
  async getProjectsFromIds(projectIds) {
    if (projectIds.length === 0) {
      return [];
    }

    const dynamodb = createDynamoDbInstance();
    const params = {
      RequestItems: {
        [this.projectsTableName]: {
          Keys: projectIds.map((projectUuid) => convertToDynamoDbRecord({ projectUuid })),
        },
      },
    };

    const data = await safeBatchGetItem(dynamodb, params);

    const existingProjectIds = new Set(data.Responses[this.projectsTableName].map((entry) => {
      const newData = convertToJsObject(entry);
      return newData.projects.uuid;
    }));

    // Build up projects that do not exist in Dynamo yet.
    const projects = projectIds
      .filter((entry) => (
        !existingProjectIds.has(entry)
      ))
      .map((emptyProject) => {
        const newProject = {};

        const id = emptyProject;
        newProject.name = id;
        newProject.uuid = id;
        newProject.samples = [];
        newProject.metadataKeys = [];
        newProject.experiments = [id];

        return newProject;
      });

    data.Responses[this.projectsTableName].forEach((entry) => {
      const newData = convertToJsObject(entry);
      projects.push(newData.projects);
    });

    return projects;
  }

  async getExperiments(projectUuid) {
    const dynamodb = createDynamoDbInstance();

    const marshalledKey = convertToDynamoDbRecord({ projectUuid });

    const params = {
      TableName: this.projectsTableName,
      Key: marshalledKey,
    };

    try {
      const response = await dynamodb.getItem(params).promise();
      const result = convertToJsObject(response.Item);

      if (!Object.prototype.hasOwnProperty.call(result, 'projects')) return [];

      const experiments = await experimentService.getListOfExperiments(result.projects.experiments);


      return experiments;
    } catch (e) {
      if (e.statusCode === 400) throw new NotFoundError('Project not found');
      throw e;
    }
  }

  async deleteProject(projectUuid) {
    logger.log(`Deleting project with id ${projectUuid}`);
    const marshalledKey = convertToDynamoDbRecord({
      projectUuid,
    });

    const params = {
      TableName: this.projectsTableName,
      Key: marshalledKey,
    };

    const dynamodb = createDynamoDbInstance();

    try {
      const { experiments, samples: sampleUuids } = await this.getProject(projectUuid);

      if (experiments.length > 0) {
        const deletePromises = experiments.reduce((acc, experimentId) => {
          acc.push(experimentService.deleteExperiment(experimentId));
          // acc.push(accessService.deleteExpqgaeriment(experimentId));
          acc.push(samplesService.deleteSamplesEntry(projectUuid, experimentId, sampleUuids));
          return acc;
        }, []);

        await Promise.all(deletePromises);
      }

      await dynamodb.deleteItem(params).promise();

      return OK();
    } catch (e) {
      if (e.statusCode === 400) throw new NotFoundError('Project not found');
      throw e;
    }
  }

  async createEmptySamplesEntry(projectUuid, experimentId) {
    const dynamodb = createDynamoDbInstance();

    const marshalledData = convertToDynamoDbRecord({
      ':emptySamples': {},
      ':projectUuid': projectUuid,
    });

    const emptyAttributeParams = {
      TableName: this.samplesTableName,
      Key: convertToDynamoDbRecord({ experimentId }),
      UpdateExpression: 'SET samples = :emptySamples, projectUuid = :projectUuid',
      ExpressionAttributeValues: marshalledData,
    };

    await dynamodb.updateItem(emptyAttributeParams).promise();
  }
}


module.exports = ProjectsService;
