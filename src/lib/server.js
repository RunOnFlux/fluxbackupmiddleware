const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const { apiLimiter } = require('../services/utils/requestLimits');

const app = express();

app.use(cors());
app.use(apiLimiter);
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());
require('../routes')(app);

module.exports = app;
