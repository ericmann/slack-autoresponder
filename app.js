const serverless = require('serverless-http');
const express = require('express');
const { WebClient } = require('@slack/web-api');
const { createEventAdapter } = require('@slack/events-api');
const AWS = require('aws-sdk');
const smsTool = process.env.SMS_TOOL;

// Twilio Integration
const accountSid = process.env.TWILIO_SID;
const authToken = process.env.TWILIO_TOKEN;
let twilio = null;
if (smsTool === 'twilio' && accountSid && authToken) {
  twilio = require('twilio')(accountSid, authToken);
}

// RingCentral Integration
const SDK = require('@ringcentral/sdk').SDK
const ringCentralClientId = process.env.RINGCENTRAL_CLIENT_ID;
const ringCentralClientSecret = process.env.RINGCENTRAL_CLIENT_SECRET;
let rcsdk = null;
if (smsTool === 'ringcentral' && ringCentralClientId && ringCentralClientSecret) {
  rcsdk = new SDK({
    server: process.env.RINGCENTRAL_SERVER,
    clientId: ringCentralClientId,
    clientSecret: ringCentralClientSecret
  });
}

// Get our environment variables
const slackSigningSecret = process.env.SLACK_SIGNING_SECRET;
const slackAccessToken = process.env.SLACK_ACCESS_TOKEN;
const me = process.env.SLACK_USER_ID;
if (!slackSigningSecret || !slackAccessToken) {
  throw new Error('A Slack signing secret and access token are required to run this app.');
}

// Initialize
const slackEvents = createEventAdapter(slackSigningSecret);
const web = new WebClient(slackAccessToken);
const dynamoClient = new AWS.DynamoDB.DocumentClient();

// Helper functions
async function presence() {
  let data = await web.users.getPresence({user: me});

  return data.presence === 'active';
}

async function oooMessage(channel) {
  const message = "*[Automated Response]*\nI'm not currently at my computer and might not see your Slack. " +
      " I'll get back to you as soon as I'm back at my desk. If you need my attention urgently, please " +
      "respond to this message with the word `URGENT` to send me a text message so I can get back to you ASAP.";

  await web.chat.postMessage({channel: channel, text: message, as_user: true});
}

async function urgentMessage(channel) {
  const message = "*[Automated Response]*\nGot it. Slack has now sent me a text and I'll get back to you ASAP!";

  await web.chat.postMessage({channel: channel, text: message, as_user: true});
}

async function getUsername(userId) {
  let data = await web.users.info({user: userId})

  if (data.ok) {
    return data.user.real_name;
  }

  return 'A User';
}

async function rc_sms(user) {
  if (rcsdk === null) {
    console.log('No RingCentral client');
    return false;
  }

  let platform = rcsdk.platform();
  await platform.login({
    username: process.env.RINGCENTRAL_USERNAME,
    password: process.env.RINGCENTRAL_PASSWORD,
    extension: process.env.RINGCENTRAL_EXTENSION
  })

  await platform.post('/restapi/v1.0/account/~/extension/~/sms', {
    from: {'phoneNumber': process.env.RINGCENTRAL_USERNAME},
    to: [{'phoneNumber': process.env.DEST_PHONE}],
    text: `${user} has an urgent need on Slack.`
  });

  return true;
}

async function twilio_sms(user) {
  if (twilio === null) {
    console.log('No Twilio client');
    return false;
  }

  await twilio.messages.create({
    body: `${user} has an urgent need on Slack.`,
    from: process.env.TWILIO_PHONE,
    to: process.env.DEST_PHONE
  });

  return true;
}

async function dynamoUpdateUIDExpiration(uid) {
  const expires = Date.now() + 1000 * 60 * 10;
  const deleteItem = {
    TableName: process.env.CONTACT_TABLE,
    Key: {
      "uid": uid
    }
  };
  const putItem = {
    TableName: process.env.CONTACT_TABLE,
    Item: {
      'uid': uid,
      'expires': expires
    }
  };

  try {
    try {
      await dynamoClient.delete(deleteItem).promise();
    } catch(error) {
      console.log(error);
    }
    await dynamoClient.put(putItem).promise();
    console.log(`We won't respond to ${uid} until after ${expires}.`);
  } catch(error) {
    console.log(`Error creating Dynamo entry for ${uid}.`);
    console.log(error);
  }
}

async function shouldRespond(uid) {
  const ignoredUsers = process.env.SLACK_IGNORE_LIST.split(',');
  if (ignoredUsers.includes(uid)) {
    // Some people should never get an autoresponse.
    console.log(`Avoiding annoying ${uid} with an autoresponse ...`);
    return false;
  }

  const getItem = {
    TableName: process.env.CONTACT_TABLE,
    Key: {
      "uid": uid
    }
  };
  try {
    let cached = await dynamoClient.get(getItem).promise();
    if (cached !== undefined && cached.Item !== undefined) {
      let item = cached.Item;

      if (item.expires !== undefined && item.expires > Date.now()) {
        console.log(`User ${uid} is cached until ${item.expires}. Ignoring ...`);
        // It's too soon ...
        return false;
      }
    }
  } catch(error) {
    console.log(error);
    // Noop - the record does not exist
    console.log(`No cache for ${uid} ... responding.`);
  }

  await dynamoUpdateUIDExpiration(uid);
  return true; // Send a response.
}

// Attach a listener
slackEvents.on('message', async (event) => {
  const message = event.text;
  const channel = event.channel;

  if (event.channel_type !== 'im' || (event.subtype !== undefined && event.subtype === 'message_deleted')) {
    return;
  }

  if (message !== undefined && message.replace(/\W/g, '').toLowerCase().startsWith('urgent')) {
    console.log('Urgent message. Contacting via SMS!');
    let user = await getUsername(event.user);
    try {
      let sent;
      if (smsTool === 'twilio') {
        sent = await twilio_sms(user);
      } else {
        sent = await rc_sms(user);
      }
      sent && await urgentMessage(channel);
    } catch(error) {
      console.log(error);
    }
    return;
  }

  let online = await presence();
  if (!online) {
    const respond = await shouldRespond(event.user);
    if (respond) {
      // Tell the person we'll get back to them later.
      await oooMessage(channel);
    }
  }
});

const app = express();
app.use('/slack/events', slackEvents.expressMiddleware());

let handler;
module.exports.handler = async (event, context, callback) => {
  if (!handler) {
    handler = serverless(app, {
      request(request) {
        request.rawBody = request.body;
      },
    });
  }

  const response = await handler(event, context);

  callback(null, response);
}