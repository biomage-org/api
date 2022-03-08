const config = require('../../config');

const CacheSingleton = require('../../cache');

module.exports = {
  'health#check': (req, res) => {
    res.json({
      status: 'up',
      env: process.env.NODE_ENV,
      clusterEnv: config.clusterEnv,
      caching: CacheSingleton.get().isReady(),
    });
  },
};
