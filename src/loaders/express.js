const bodyParser = require('body-parser');
const cors = require('cors');
const path = require('path');
const { OpenApiValidator } = require('express-openapi-validator');

module.exports = async (app) => {
  app.get('/status', (req, res) => {
    res.status(200).end();
  });

  // Useful if you're behind a reverse proxy (Heroku, Bluemix, AWS ELB, Nginx, etc)
  // It shows the real origin IP in the heroku or Cloudwatch logs
  app.enable('trust proxy');

  // Enable Cross Origin Resource Sharing to all origins by default
  app.use(cors());

  // Middleware that transforms the raw string of req.body into json
  app.use(bodyParser.urlencoded({ extended: false }));
  app.use(bodyParser.text());
  app.use(bodyParser.json());

  await new OpenApiValidator({
    apiSpec: path.join(__dirname, '..', 'specs', 'api.yaml'),
    validateRequests: true,
    validateResponses: true,
    operationHandlers: path.join(__dirname, '..', 'api'),
  }).install(app);

  // Custom error handler.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    // format errors
    res.status(err.status || 500).json({
      message: err.message,
      errors: err.errors,
    });
  });
};