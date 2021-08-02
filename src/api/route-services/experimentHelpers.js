const {
  convertToDynamoDbRecord,
  batchConvertToDynamoUpdateParams,
} = require('../../utils/dynamoDb');

const toUpdatePropertyArray = (updatePropertyObject) => (
  Object.entries(updatePropertyObject).map(([key, val]) => ({ name: key, body: val }))
);

/**
 *
 * @param {*} body Object containing the attributes keys to update
 *  as key and the new values to set as value
 *  IMPORTANT this only updates the attributes that are deep (objects with properties)
 * @returns An { updateExpressionList, attributeNames, attributeValues } object
 *  that can be used in dynamodb params
 *  (the updateExprList needs to be changed to `SET updateExprList.join(', ')` first)
 */
const getDeepAttrsUpdateParams = (body) => {
  const deepAttributesToUpdate = ['meta', 'processingConfig'].filter((key) => body[key]);

  const configUpdatesDictionary = {};
  deepAttributesToUpdate.forEach((key) => {
    configUpdatesDictionary[key] = toUpdatePropertyArray(body[key]);
  });

  return batchConvertToDynamoUpdateParams(deepAttributesToUpdate, configUpdatesDictionary);
};

/**
 *
 * @param {*} body Object containing the attributes keys to update
 *  as key and the new values to set as value
 *  IMPORTANT this only updates the attributes that are shallow (not objects with properties)
 * @returns An { updateExpressionList, attributeValues } object
 *  that can be used in dynamodb params
 *  (the updateExpressionList needs to be changed to `SET updateExpressionList.join(', ')` first)
 */
const getShallowAttrsUpdateParams = (body) => {
  const dataToUpdate = {
    experimentName: body.name || body.experimentName,
    apiVersion: body.apiVersion,
    createdDate: body.createdDate,
    lastViewed: body.lastViewed,
    projectId: body.projectUuid || body.projectId,
    description: body.description,
    sampleIds: body.sampleIds,
  };

  const objectToMarshall = {};
  const updateExpressionList = Object.entries(dataToUpdate).reduce(
    (acc, [key, val]) => {
      if (!val) {
        return acc;
      }

      const expressionKey = `:${key}`;
      objectToMarshall[expressionKey] = val;

      return [...acc, `${key} = ${expressionKey}`];
    }, [],
  );

  const attributeValues = convertToDynamoDbRecord(objectToMarshall);

  return { updateExpressionList, attributeValues };
};

module.exports = {
  toUpdatePropertyArray,
  getDeepAttrsUpdateParams,
  getShallowAttrsUpdateParams,
};
