const config = require('../../config');
const {
  createDynamoDbInstance, convertToDynamoDbRecord, convertToJsObject,
} = require('../../utils/dynamoDb');
const logger = require('../../utils/logging');

const { OK, NotFoundError } = require('../../utils/responses');

const SamplesService = require('./samples');
const ExperimentService = require('./experiment');

const samplesService = new SamplesService();
const experimentService = new ExperimentService();
class ProjectsService {
  constructor() {
    this.tableName = `projects-${config.clusterEnv}`;
  }

  async getProject(projectUuid) {
    logger.log(`Getting project item with id ${projectUuid}`);
    const marshalledKey = convertToDynamoDbRecord({
      projectUuid,
    });

    const params = {
      TableName: this.tableName,
      Key: marshalledKey,
    };

    const dynamodb = createDynamoDbInstance();
    const response = await dynamodb.getItem(params).promise();
    if (response.Item) {
      const prettyResponse = convertToJsObject(response.Item);
      return prettyResponse.projects;
    }

    logger.log('Project not found');
    return response;
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
      TableName: this.tableName,
      Key: marshalledKey,
      UpdateExpression: 'SET projects = :project',
      ExpressionAttributeValues: marshalledData,
    };

    const dynamodb = createDynamoDbInstance();

    try {
      await dynamodb.updateItem(params).send();
      return OK();
    } catch (e) {
      if (e.statusCode === 400) throw new NotFoundError('Project not found');
      throw e;
    }
  }

  /**
   * Finds all projects referenced in experiments.
   */
  async getProjects() {
    // Get project data from the experiments table. Only return
    // those tables that have a project ID associated with them.
    const params = {
      TableName: experimentService.experimentsTableName,
      ExpressionAttributeNames: {
        '#pid': 'projectId',
      },
      FilterExpression: 'attribute_exists(projectId)',
      ProjectionExpression: '#pid',
    };

    const dynamodb = createDynamoDbInstance();
    const response = await dynamodb.scan(params).promise();

    if (!response.Items) {
      throw new NotFoundError('No projects available!');
    }

    const projectIds = response.Items.map((entry) => convertToJsObject(entry).projectId);
    return this.getProjectsFromIds(new Set(projectIds));
  }

  /**
   * Returns information about a group of projects.
   *
   * @param {Set} projectIds A Set of projectId values that are to be queried.
   * @returns An object containing descriptions of projects.
   */
  async getProjectsFromIds(projectIds) {
    const dynamodb = createDynamoDbInstance();
    const params = {
      RequestItems: {
        [this.tableName]: {
          Keys: [...projectIds].map((projectUuid) => convertToDynamoDbRecord({ projectUuid })),
        },
      },
    };

    const data = await dynamodb.batchGetItem(params).promise();
    const existingProjectIds = new Set(data.Responses[this.tableName].map((entry) => {
      const newData = convertToJsObject(entry);
      return newData.projects.uuid;
    }));

    // Build up projects that do not exist in Dynamo yet.
    const projects = [...projectIds]
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

    data.Responses[this.tableName].forEach((entry) => {
      const newData = convertToJsObject(entry);
      projects.push(newData.projects);
    });

    return projects;
  }

  async getExperiments(projectUuid) {
    const dynamodb = createDynamoDbInstance();

    const marshalledKey = convertToDynamoDbRecord({ projectUuid });

    const params = {
      TableName: this.tableName,
      Key: marshalledKey,
    };

    try {
      const response = await dynamodb.getItem(params).promise();
      const result = convertToJsObject(response.Item);

      return experimentService.getListOfExperiments(result.projects.experiments);
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
      TableName: this.tableName,
      Key: marshalledKey,
    };

    const dynamodb = createDynamoDbInstance();

    try {
      const { experiments } = await this.getProject(projectUuid);

      if (experiments.length > 0) {
        const deletePromises = experiments.map(
          (experimentId) => samplesService.deleteSamples(projectUuid, experimentId),
        );

        await Promise.all(deletePromises);
      }

      await dynamodb.deleteItem(params).send();

      return OK();
    } catch (e) {
      if (e.statusCode === 400) throw new NotFoundError('Project not found');
      throw e;
    }
  }
}


module.exports = ProjectsService;