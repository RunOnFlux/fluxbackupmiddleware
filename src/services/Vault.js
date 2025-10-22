const secrets = require('../../secrets');

class Vault {
  static async getKey(keyname) {
    if (keyname in secrets) return secrets[keyname];
    return null;
  }
}
module.exports = Vault;
