require('dotenv').config()
const clementine = require('./clementine');
const express = require("express");
const app = express();
const {
  initDatabase,
  executeQuery,
  executeSelectQuery,
} = require("./db.js");
const cors = require("cors");
const axios = require("axios").default;
app.use(express.json());
app.use(cors());

const keycloak = {
  enabled: typeof process.env.ABOTKIT_MAEVE_USE_KEYCLOAK !== 'undefined' && process.env.ABOTKIT_MAEVE_USE_KEYCLOAK.toLowerCase() === 'true',
  realm: process.env.ABOTKIT_MAEVE_KEYCLOAK_REALM,
  url: `${process.env.ABOTKIT_MAEVE_KEYCLOAK_HOST}:${process.env.ABOTKIT_MAEVE_KEYCLOAK_PORT}`,
  client_id: process.env.ABOTKIT_MAEVE_KEYCLOAK_CLIENT
};

const MAEVE_ADMIN_ROLE = 'maeve-admin';

const hasAuthorizationHeader = req => {
  if (keycloak.enabled) {
    return typeof req.headers['authorization'] !== 'undefined' && req.headers['authorization'].split(' ')[0] === 'Bearer';
  } else {
    return false;
  }
}

const decodeToken = req => {
  const token = req.headers['authorization'].split(' ')[1];
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
}

const validateTokenIfExists = async (req, res, next) => {
  if (hasAuthorizationHeader(req)) {
    try {
      const { realm, url } = keycloak;
      const user = await axios.get(`${url}/auth/realms/${realm}/protocol/openid-connect/userinfo`, {
        headers: { 'Authorization': req.headers['authorization'] }
      });
      const token = decodeToken(req);
      req.user = {
        ...user.data,
        roles: token.resource_access[keycloak.client_id].roles
      }
    } catch (error) {
      console.error(error);
    } finally {
      next();
    }
  } else {
    next();
  }
}

const hasUserRole = (user, role) => {
  if (keycloak.enabled) {
    return typeof user !== 'undefined' && user.roles.includes(role);
  } else {
    return true;
  }
}

app.use(validateTokenIfExists);

const getBotByName = async name => {
  const sql = "SELECT * FROM bots WHERE name=?";
  let response = null;
  try {
    response = await executeSelectQuery(sql, [name]);
  } catch (error) {
    return {
      bot: undefined,
      error: error,
      status: 500
    }
  }

  const bot = response[0];
  if (typeof bot === "undefined") {
    return {
      bot: undefined,
      error: "Bot not found.",
      status: 404
    }
  } else {
    return {
      bot: bot,
      error: null,
      status: 200
    }
  }
}

app.get('/', (req, res) => {
  res.status(200).send('"It’s A Difficult Thing, Realizing Your Entire Life Is Some Hideous Fiction." - Maeve Millay');
});

app.get('/alive', (req, res) => {
  res.status(200).end();
});

app.get('/bots', async (req, res) => {
  const sql = 'SELECT * FROM bots';
  try {
    const bots = await executeSelectQuery(sql);
    res.json(bots);
  } catch (error) {
    res.status(500).json({ error: error });
  }
});

app.post('/bot', async (req, res) => {
  if (!hasUserRole(req.user, MAEVE_ADMIN_ROLE)) {
    return res.status(401).end();
  }

  const { name, host, port } = req.body;
  const sql = 'INSERT INTO bots (name, host, port, type) VALUES (?, ?, ?, ?)';
  const type = req.body.type.toLowerCase() === 'charlotte' ? 'charlotte' : 'robert';
  try {
    await executeQuery(sql, [name, host, port, type]);
  } catch (error) {
    res.status(500).json({ error: error });
  }

  res.status(200).end();
});

app.get("/bot/:name/status", async (req, res) => {
  const { bot, error, status } = await getBotByName(req.params.name);
  if (error) {
    return res.status(status).json({ error: error });
  }

  try {
    await axios.get(`${bot.host}:${bot.port}/`);
    res.status(200).send();
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/bot/:name/settings", async (req, res) => {
  const { bot, error, status } = await getBotByName(req.params.name);
  if (error) {
    return res.status(status).json({ error: error });
  }

  let response;
  try {
    response = await axios.get(`${bot.host}:${bot.port}/language`);
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  if (!hasUserRole(req.user, `${req.params.name}-write`)) {
    res.json({ host: '', port: '', type: '', language: response.data });
  } else {
    res.json({ ...bot, language: response.data });
  }
});

app.get("/bot/:name/actions", async (req, res) => {
  if (!hasUserRole(req.user, `${req.params.name}-write`)) {
    return res.status(401).end();
  }

  const { bot, error, status } = await getBotByName(req.params.name);
  if (error) {
    return res.status(status).json({ error: error });
  }

  try {
    const response = await axios.get(`${bot.host}:${bot.port}/actions`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get("/bot/:name/phrases", async (req, res) => {
  const { bot, error, status } = await getBotByName(req.params.name);
  if (error) {
    return res.status(status).json({ error: error });
  }

  try {
    const response = await axios.get(`${bot.host}:${bot.port}/phrases`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.delete("/phrase", async (req, res) => {
  if (!hasUserRole(req.user, `${req.body.bot}-write`)) {
    return res.status(401).end();
  }

  const { bot, error, status } = await getBotByName(req.body.bot);
  if (error) {
    return res.status(status).json({ error: error });
  }

  try {
    await axios.delete(`${bot.host}:${bot.port}/phrases`, {
      data: {
        phrases: [{ intent: req.body.intent, text: req.body.text }],
      },
    });
    res.status(200).end();
  } catch (error) {
    res.status(500).json(error);
  }
});

app.post("/phrases", async (req, res) => {
  if (!hasUserRole(req.user, `${req.body.bot}-write`)) {
    return res.status(401).end();
  }

  const { bot, error, status } = await getBotByName(req.body.bot);
  if (error) {
    return res.status(status).json({ error: error });
  }

  try {
    await axios.post(`${bot.host}:${bot.port}/phrases`, {
      phrases: req.body.phrases.map((phrase) => ({
        text: phrase.text,
        intent: phrase.intent,
      })),
    });
  } catch (error) {
    return res.status(500).json(error);
  }

  res.status(200).end();
});

app.get("/bot/:name/intents", async (req, res) => {
  if (!hasUserRole(req.user, `${req.params.name}-write`)) {
    return res.status(401).end();
  }

  const { bot, error, status } = await getBotByName(req.params.name);
  if (error) {
    return res.status(status).json({ error: error });
  }

  try {
    const response = await axios.get(`${bot.host}:${bot.port}/example`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/language', async (req, res) => {
  if (!hasUserRole(req.user, `${req.body.bot}-write`)) {
    return res.status(401).end();
  }

  const { bot, error, status } = await getBotByName(req.body.bot);
  if (error) {
    return res.status(status).json({ error: error });
  }

  try {
    await axios.post(`${bot.host}:${bot.port}/language`, {
      country_code: req.body.country_code
    });
  } catch (error) {
    return res.status(500).json(error);
  }

  res.status(200).end();
});

app.post("/handle", async (req, res) => {
  const { bot, error, status } = await getBotByName(req.body.bot);
  if (error) {
    return res.status(status).json({ error: error });
  }

  let response;
  try {
    response = await axios.post(`${bot.host}:${bot.port}/handle`, {
      identifier: req.body.identifier,
      query: req.body.query
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(response.data);
});

app.post("/explain", async (req, res) => {
  if (!hasUserRole(req.user, `${req.body.bot}-write`)) {
    return res.status(401).end();
  }

  const { bot, error, status } = await getBotByName(req.body.bot);
  if (error) {
    return res.status(status).json({ error: error });
  }

  let response;
  try {
    response = await axios.post(`${bot.host}:${bot.port}/explain`, {
      query: req.body.query
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }

  res.json(response.data);
});

app.get("/intent/:intent/bot/:name/examples", async (req, res) => {
  if (!hasUserRole(req.user, `${req.params.name}-write`)) {
    return res.status(401).end();
  }

  const { bot, error, status } = await getBotByName(req.params.name);
  if (error) {
    return res.status(status).json({ error: error });
  }

  try {
    const response = await axios.get(`${bot.host}:${bot.port}/example/${req.params.intent}`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/example', async (req, res) => {
  if (!hasUserRole(req.user, `${req.body.bot}-write`)) {
    return res.status(401).end();
  }

  const { bot, error, status } = await getBotByName(req.body.bot);
  if (error) {
    return res.status(status).json({ error: error });
  }

  try {
    await axios.post(`${bot.host}:${bot.port}/example`, {
      example: req.body.example,
      intent: req.body.intent
    });
  } catch (error) {
    return res.status(500).json(error);
  }

  res.status(200).end();
});

app.delete('/example', async (req, res) => {
  if (!hasUserRole(req.user, `${req.body.bot}-write`)) {
    return res.status(401).end();
  }

  const { bot, error, status } = await getBotByName(req.body.bot);
  if (error) {
    return res.status(status).json({ error: error });
  }

  try {
    await axios.delete(`${bot.host}:${bot.port}/example`, {
      data: { example: req.body.example }
    });
  } catch (error) {
    return res.status(500).json(error);
  }

  res.status(200).end();
});

app.post("/intent", async (req, res) => {
  if (!hasUserRole(req.user, `${req.body.bot}-write`)) {
    return res.status(401).end();
  }

  const { bot, error, status } = await getBotByName(req.body.bot);
  if (error) {
    return res.status(status).json({ error: error });
  }

  try {
    await axios.post(`${bot.host}:${bot.port}/actions`, {
      name: req.body.action,
      intent: req.body.intent,
      settings: {},
    });
  } catch (error) {
    console.warn(
      `Couldn't update core bot. Failed to push action to ${bot.host}:${bot.port}/actions ` +
      error
    );
  }

  if (typeof req.body.examples !== "undefined") {
    for (const example of req.body.examples) {
      try {
        await axios.post(`${bot.host}:${bot.port}/example`, {
          example: example,
          intent: req.body.intent,
        });
      } catch (error) {
        console.warn(
          `Couldn't update core bot. Failed to push examples to ${bot.host}:${bot.port}/example ` +
          error
        );
      }
    }
  }
  res.status(200).end();
});

// --- Clementine ---
app.post('/integration', async (req, res) => {
  /* req.body = {
      bot: 'bot-id',
      name: '',
      uuid: '' [optional on update],
      type: 'integration type e.g. wordpress'
      config: {url: ''}
  }*/
  try {
    if (typeof req.body.uuid === 'undefined') {
      const integration = await clementine.createIntegration(req.body);
      res.json(integration);
    } else {
      const integration = await clementine.updateIntegration(req.body);
      res.json(integration);
    }
  } catch (error) {
    res.status(500).json({ error: error });
  }
});

app.delete('/integration', async (req, res) => {
  // req.body = { bot: '', uuid: '' }
  if (typeof req.query.bot === 'undefined' || typeof req.query.uuid === 'undefined') {
    res.status(400).json({ error: 'Missing parameters. Needed {bot, uuid}' });
  } else {
    try {
      await clementine.deleteIntegration({ bot: req.query.bot, uuid: req.query.uuid });
      res.status(200).end();
    } catch (error) {
      res.status(500).json({ error: error });
    }
  }
});

app.get('/integration', async (req, res) => {
  // req.body = { bot: '', uuid: '' }
  try {
    if (typeof req.query.bot === 'undefined' && typeof req.query.uuid === 'undefined') {
      res.status(400).end();
    } else {
      const integration = await clementine.getIntegration({ bot: req.query.bot, uuid: req.query.uuid });
      if (typeof integration !== 'undefined') {
        res.status(200).json(integration);
      } else {
        res.status(204).end();
      }
    }
  } catch (error) {
    res.status(500).json({ error: error });
  }
});

app.get('/integrations', async (req, res) => {
  /* req.body = {
      bot: 'bot-id',
      type: 'integration type e.g. wordpress'
  }*/
  try {
    const integrations = await clementine.getIntegrations(req.body);
    res.status(200).json(integrations);
  } catch (error) {
    res.status(500).json({ error: error });
  }
});

app.get('/integration/body', async (req, res) => {
  try {
    res.json(await clementine.generateIntegration(req.query.id));
  } catch (error) {
    res.status(500).json({ error: error });
  }
});
// --- Clementine ---

const port = process.env.ABOTKIT_MAEVE_PORT || 3000;

app.listen(port, async () => {
  await initDatabase();
  console.log(`"It's Time You And I Had A Chat" - I'm listening on port ${port}!`);
});