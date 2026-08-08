const { MongoClient } = require('mongodb');
const config = require('../settings');

let mongoClient, mongoDB;
let sessionsCol, numbersCol, configsCol;

async function initMongo() {
  if (mongoClient && mongoClient.topology?.isConnected?.()) return;
  mongoClient = new MongoClient(config.MONGO_URI);
  await mongoClient.connect();
  mongoDB = mongoClient.db(config.MONGO_DB);
  sessionsCol = mongoDB.collection('sessions');
  numbersCol = mongoDB.collection('numbers');
  configsCol = mongoDB.collection('configs');
  
  await sessionsCol.createIndex({ number: 1 }, { unique: true });
  await numbersCol.createIndex({ number: 1 }, { unique: true });
  console.log('✅ MongoDB initialized');
}

async function saveCredsToMongo(number, creds) {
  await initMongo();
  const sanitized = number.replace(/[^0-9]/g, '');
  await sessionsCol.updateOne({ number: sanitized }, { $set: { number: sanitized, creds, updatedAt: new Date() } }, { upsert: true });
}

async function loadCredsFromMongo(number) {
  await initMongo();
  const sanitized = number.replace(/[^0-9]/g, '');
  return await sessionsCol.findOne({ number: sanitized });
}

async function removeSessionFromMongo(number) {
  await initMongo();
  const sanitized = number.replace(/[^0-9]/g, '');
  await sessionsCol.deleteOne({ number: sanitized });
}

async function addNumberToMongo(number) {
  await initMongo();
  const sanitized = number.replace(/[^0-9]/g, '');
  await numbersCol.updateOne({ number: sanitized }, { $set: { number: sanitized } }, { upsert: true });
}

async function getAllNumbersFromMongo() {
  await initMongo();
  const docs = await numbersCol.find({}).toArray();
  return docs.map(d => d.number);
}

// For storing config like DP per user (if needed)
async function setUserConfig(number, key, value) {
  await initMongo();
  const sanitized = number.replace(/[^0-9]/g, '');
  await configsCol.updateOne({ number: sanitized }, { $set: { [key]: value } }, { upsert: true });
}

module.exports = {
  initMongo,
  saveCredsToMongo,
  loadCredsFromMongo,
  removeSessionFromMongo,
  addNumberToMongo,
  getAllNumbersFromMongo,
  setUserConfig
};
