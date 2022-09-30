#!/usr/bin/env node

/**
 * Module dependencies.
 */

const debug = require('debug')('viber-package-inventories-bot:server');
const https = require('https');
import nodeFetch from 'node-fetch';
const express = require('express');
const bodyParser = require("body-parser");
const mongoose = require('mongoose');
require('dotenv').config();


const app = express();

const user = process.env.DB_USER;
const pwd = process.env.DB_PWD;
const dbPort = process.env.DB_PORT;
const addr = process.env.DB_ADDR;

const ViberBot = require('viber-bot').Bot;
const BotEvents = require('viber-bot').Events;
const TextMessage = require('viber-bot').Message.Text;

const fs = require('fs');

const bot = new ViberBot({
  authToken: process.env.TOKEN,
  name: "Описи",
  avatar: "http://viber.com/avatar.jpg" // It is recommended to be 720x720, and no more than 100kb.
});

app.use(bodyParser.urlencoded({limit: '10mb', extended: true}));
app.use(bodyParser.json({limit: '10mb', extended: true}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/viber/webhook", bot.middleware());

app.use(function (req: any, res: any, next: any) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader("Access-Control-Allow-Headers", "Access-Control-Allow-Headers, Origin,Accept, X-Requested-With, Content-Type, Access-Control-Request-Method, Access-Control-Request-Headers, Authorization");
  next();
});

app.post('/inventory', async (req: any, res: any) => {

  console.log(`${new Date().toLocaleString('ru')} Post package inventory: `, req.body.direction, req.body.inventoryStr);

  const usersIds: string[] | null = await getViberUserIdsByDirection(req.body.direction);

  if(!usersIds) {
    console.error(`${new Date().toLocaleString('ru')} Getting viber user ids by direction error`);
    // @ts-ignore
    await sendServiceMessage(`viber: Ошибка получения пользователей по городу ${req.body.direction}`, process.env.SECRET);
    res.status(500).end();
    return;
  }

  if(!usersIds.length) {
    console.log(`${new Date().toLocaleString('ru')} No users to send ${req.body.direction} inventory`);
    // @ts-ignore
    await sendServiceMessage(`viber: Нет подписчиков для описи ${req.body.direction}`, process.env.SECRET);
    res.status(410).end();
    return;
  }

  for(const userId of usersIds) {
    bot.sendMessage(
      {id: userId},
      new TextMessage(
        req.body.inventoryStr
      )
    );
  }

  res.status(200).send();
});

bot.on(BotEvents.MESSAGE_RECEIVED, async(message: any, response: any) => {
  console.log('----------------------------------------------------------------');
  console.log(`${new Date().toLocaleString('ru')} New message: `, message.text);
  console.log('From: ', response.userProfile.id, );
  console.log('Name: ', response.userProfile.name);

  bot.sendMessage({id: process.env.ADMIN_ID}, new TextMessage(`New message from user: ${response.userProfile.id} ${response.userProfile.name}: ${message.text}`));

  const newItem = await addAndDeleteViberUserIdToDirection(response.userProfile.id, message.text);

  if(!newItem) {
    response.send(new TextMessage(`Ошибка добавления города`));
    // @ts-ignore
    await sendServiceMessage(`viber-inventories: Ошибка получения/добавления города у ${response.userProfile.name} - ${response.userProfile.id}`, process.env.SECRET);
    return;
  }

  const directions = await getDirectionsByViberUserId(response.userProfile.id);

  if(!directions) {
    response.send(new TextMessage(`Ошибка получения вашего списка городов`));
    // @ts-ignore
    await sendServiceMessage(`viber: Ошибка получения списка городов у ${response.userProfile.name} - ${response.userProfile.id}`, process.env.SECRET);
    return;
  } else {
    response.send(new TextMessage(`Вы подписаны на города: ${directions.join(', ')}`));
  }

  // response.send(message);
});

mongoose.connect(`mongodb://${user}:${pwd}@${addr}:${dbPort}/timesheetsblocks?authSource=admin`, {useNewUrlParser: true, useUnifiedTopology: true});

const mongodb = mongoose.connection;
mongodb.on('error', console.error.bind(console, 'connection error:'));
mongodb.once('open', function(msg: any) {
  // we're connected!
  console.log(`${new Date().toLocaleString('ru')} Mongoose connected: `, msg);
});

const inventoriesViberMailingSchema = new mongoose.Schema({
  direction: {
    type: String,
    required: true,
    unique: true,
  },
  viber_user_ids: [{
    type: String,
    required: true,
    unique: false,
  }]
}, { timestamps: { createdAt: 'created_at', updatedAt: 'updated_at' } });

const InventoriesViberMailing = mongoose.model('InventoriesViberMailing', inventoriesViberMailingSchema);

const getViberUserIdsByDirection = async (direction: string): Promise<string[] | null> => {
  let item;
  try {
    item = await InventoriesViberMailing.findOne({direction}).exec();
    console.log(`${new Date().toLocaleString('ru')} Getting viber user ids by direction result: `, item);
  } catch (e) {
    console.log(`${new Date().toLocaleString('ru')} Getting viber user ids by direction error: `, e);
    return null;
  }
  return item ? item.viber_user_ids : null;
}

const addAndDeleteViberUserIdToDirection = async (userId: string, direction: string) => {
  const viberUserIds = await getViberUserIdsByDirection(direction);
  if(!viberUserIds) {
    console.log(`${new Date().toLocaleString('ru')} Gonna add userId to direction: `, userId, direction);
    let result;
    try {
      const newItem = new InventoriesViberMailing({direction, viber_user_ids: [userId]});
      result = await newItem.save();
      console.log(`${new Date().toLocaleString('ru')} Direction added with result: `, result);
    } catch(err) {
      console.log(`${new Date().toLocaleString('ru')} Direction adding error: `, err);
      result = false;
    }
    return result;
  } else {
    console.log(`${new Date().toLocaleString('ru')} There are viber users for ${direction}: `, viberUserIds);
    let newIds: string[];
    if(viberUserIds.includes(userId)) {
      newIds = viberUserIds.filter((viberUserId: string) => viberUserId !== userId);
    } else {
      newIds = [...viberUserIds, userId];
    }
    let item;
    try {
      console.log(`${new Date().toLocaleString('ru')} Gonna update ${direction} with new ids: `, newIds);
      item = await InventoriesViberMailing.findOneAndUpdate({direction}, {viber_user_ids: newIds}, {new: true}).exec();
      console.log(`${new Date().toLocaleString('ru')} Updating viber user ids on ${direction} result: `, item);
      return item;
    } catch (e) {
      console.log(`${new Date().toLocaleString('ru')} Updating viber user ids on ${direction} error: `, e);
      return false;
    }
  }
}

const getDirectionsByViberUserId = async(userId: string) => {
  console.log(`${new Date().toLocaleString('ru')} Gonna get directions by userId: `, userId);
  let items;
  try {
    items = await InventoriesViberMailing.find({viber_user_ids: userId}).exec();
    console.log(`${new Date().toLocaleString('ru')} Getting directions by viber user id ${userId} items: `, items);
    const directions: string[] = items.map((item: any) => item.direction);
    console.log(`${new Date().toLocaleString('ru')} Getting directions by viber user id ${userId} result: `, directions);
    return directions;
  } catch (e) {
    console.log(`${new Date().toLocaleString('ru')} Getting directions by viber user id ${userId}  error: `, e);
    return false;
  }
};

const sendServiceMessage = async (messageText: string, st:string) => {

  const url = process.env.SERVER_ADDR + "sendservicemessage";

  try {
    const response = await nodeFetch(url, {
      method: 'POST', // *GET, POST, PUT, DELETE, etc.
      // mode: 'cors', // no-cors, *cors, same-origin
      // cache: 'no-cache', // *default, no-cache, reload, force-cache, only-if-cached
      // credentials: 'same-origin', // include, *same-origin, omit
      headers: {
        'Content-Type': 'application/json'
        // 'Content-Type': 'application/x-www-form-urlencoded',
      },
      // redirect: 'follow', // manual, *follow, error
      // referrerPolicy: 'no-referrer', // no-referrer, *client
      body: JSON.stringify({ messageText, st }) // body data type must match "Content-Type" header
    });
    return await response.json(); // parses JSON response into native JavaScript objects
  } catch (e) {
    console.error(`${new Date().toLocaleString('ru')} Sending`, e);
    return false;
  }
};

/**
 * Get port from environment and store in Express.
 */

const port = normalizePort(process.env.PORT || '4003');

/**
 * Create HTTP server.
 */

const keyPathStr = `${process.env.SSL_KEY_PATH_FILE}`;
const certPathStr = `${process.env.SSL_CERT_PATH_FILE}`;
const caPathStr = `${process.env.SSL_CA_PATH_FILE}`;
// console.log("SSL options: ", keyPathStr, certPathStr, caPathStr);
const options = {
  key: fs.readFileSync(keyPathStr),
  cert: fs.readFileSync(certPathStr),
  ca: fs.readFileSync(caPathStr),
};

app.set('port', port);

const server = https.createServer(options, app).listen(port, () => bot.setWebhook(`${process.env.PUBLIC_URL}:${port}`));
console.log(`${new Date().toLocaleString('ru')} Server created`);

/**
 * Listen on provided port, on all network interfaces.
 */

server.on('error', onError);
server.on('listening', onListening);

/**
 * Normalize a port into a number, string, or false.
 */

function normalizePort(val: any) {
  const port = parseInt(val, 10);

  if (isNaN(port)) {
    // named pipe
    return val;
  }

  if (port >= 0) {
    // port number
    return port;
  }

  return false;
}

/**
 * Event listener for HTTP server "error" event.
 */

function onError(error: any) {
  if (error.syscall !== 'listen') {
    throw error;
  }

  const bind = typeof port === 'string'
    ? 'Pipe ' + port
    : 'Port ' + port;

  // handle specific listen errors with friendly messages
  switch (error.code) {
    case 'EACCES':
      console.error(bind + ' requires elevated privileges');
      process.exit(1);
      break;
    case 'EADDRINUSE':
      console.error(bind + ' is already in use');
      process.exit(1);
      break;
    default:
      throw error;
  }
}

/**
 * Event listener for HTTP server "listening" event.
 */

function onListening() {
  const addr = server.address();
  const bind = typeof addr === 'string'
    ? 'pipe ' + addr
    : 'port ' + addr.port;
  debug('Listening on ' + bind);
}
