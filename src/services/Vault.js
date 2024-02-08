const axios = require('axios');
const config = require('../../config/default');
const log = require('../lib/log');

/* implements Hashicorp Vault API
*  usecase:
*  const secret = await Vault.getKey('secret');
*/
class Vault {
  static secrets = {};

  static HCP_API_TOKEN = '';

  static async getKey(keyname) {
    if (keyname in this.secrets) return this.secrets[keyname];
    try {
      if (!this.HCP_API_TOKEN) {
        const requestData = {
          audience: 'https://api.hashicorp.cloud',
          grant_type: 'client_credentials',
          client_id: config.HCPClientID,
          client_secret: config.HCPClientSecret,
        };
        log.info(config);
        const response = await axios({
          method: 'post',
          url: config.HCPEndpointURL,
          headers: {
            'Content-Type': 'application/json',
          },
          data: requestData,
        });
        if ('data' in response) {
          this.HCP_API_TOKEN = response.data.access_token;
        }
      }
      const SECRETS = await axios({
        method: 'get',
        url: `https://api.cloud.hashicorp.com/secrets/2023-06-13/organizations/${config.HCPOrgID}/projects/${config.HCPProjectID}/apps/${config.HCPAppID}/open/${keyname}`,
        headers: {
          Authorization: `Bearer ${this.HCP_API_TOKEN}`,
        },
      });
      this.secrets[keyname] = SECRETS.data.secret.version.value;
      return SECRETS.data.secret.version.value;
    } catch (err) {
      log.error(err);
      return null;
    }
  }
}
module.exports = Vault;
