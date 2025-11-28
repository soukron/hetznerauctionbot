// include requirements
const fs               = require('fs'),
      axios            = require('axios'),
      telegraf         = require('telegraf'),
      winston          = require('winston'),
      objectHash       = require('object-hash'),
      humanizeDuration = require("humanize-duration");

// configuration variables with default values
const loglevel         = process.env.LOGLEVEL || 'info',
      headers          = {
       'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36'
      },
      live_data_remote = 'https://www.hetzner.com/_resources/app/data/app/live_data_sb_EUR.json',
      local_filename   = 'data/live_data.json',
      reply_format     = {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      },
      telegram_chatid  = process.env.TELEGRAM_CHATID,
      telegram_key     = process.env.TELEGRAM_KEY,
      timeout          = process.env.TIMEOUT || 60,
      session_filename = 'data/session.json',
      notification_filename = 'data/notification_counters.json',
      pending_notifications_filename = 'data/pending_notifications.json',
      premium_delay    = process.env.PREMIUM_DELAY || 30,
      max_daily_notifications = process.env.MAX_DAILY_NOTIFICATIONS || 5;

// other variables
let localServers   = {},
    remoteServers  = {},
    newServers     = {},
    sessions       = [],
    notificationCounters = {};
    
// initialize some components (bot, logger, etc.)
const bot = new telegraf(telegram_key);
const logger = winston.createLogger({
  transports: [
    new winston.transports.Console({
      level: loglevel,
      handleExceptions: true,
      format: winston.format.combine(
        winston.format.timestamp({format: 'YYYY-MM-DD HH:mm:ss'}),
        winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`+(info.splat!==undefined? `${info.splat}.` : '.'))
      )
    })
  ]
});

// compose a message from the server data
const composeMessage = (server) => {
  let message = `📌 *ID:* ${server.key}\n`;
  message += `🖥️ *CPU:* ${server.cpu}\n`;
  message += `🧮 *RAM:* ${server.ram_size}G\n`;
  message += `💽 *HDD:* ${server.hdd_hr.join(', ')}\n`;
  message += `💵 *Price:* ${parseFloat(server.price).toFixed(2)} €/month (excl. VAT)\n`;
  const description = Array.isArray(server.description) ? server.description.join(', ') : 'No description available';
  message += `📋 *Description:* ${description}\n`;
  const timeRemaining = humanizeDuration(server.next_reduce * 1000, { 
    units: ['h', 'm', 's'],
    round: true,
    delimiter: ' ',
    spacer: '',
    language: 'en'
  });
  message += `⏲️ *Expires in:* ${timeRemaining}\n\n`;
  message += 'Open the [server auction page](https://www.hetzner.com/sb?country=ot) and type the *ID* in the search box to find the details.\n';
  message += '\nDisable notifications and/or change the filters in your settings (use /start command) to stop receiving notifications.';

  return message;
}

// function to save JSON to file
const saveJSONToFile = (filename, jsonObject) => {
  fs.writeFileSync(filename, JSON.stringify(jsonObject, null, 2));
}

// function to reset notification counters if the date has changed
const resetNotificationCounterIfNeeded = (userId) => {
  const currentDate = new Date().toISOString().split('T')[0];
  if (!notificationCounters[userId]) {
    notificationCounters[userId] = {
      daily_notifications: 0,
      last_reset: currentDate
    };
  } else if (notificationCounters[userId].last_reset !== currentDate) {
    notificationCounters[userId].last_reset = currentDate;
    notificationCounters[userId].daily_notifications = 0;
  }
  saveJSONToFile(notification_filename, notificationCounters);
}

// function to read pending notifications file
const readPendingNotifications = () => {
  try {
    const data = fs.readFileSync(pending_notifications_filename);
    return JSON.parse(data);
  } catch (error) {
    return { pending: [] };
  }
}

// function to save pending notifications file
const savePendingNotifications = (pendingData) => {
  saveJSONToFile(pending_notifications_filename, pendingData);
}

// helper function to send notifications to users
const sendNotifications = async (users, server) => {
  // Generate the message text from server data
  let server_text = composeMessage(server);

  for (const session of users) {
    try {
      if (session.data.notifications === false) {
        logger.debug(`Skipping filter settings for user ${session.id} (${session.data.username})`);
        continue;
      }

      logger.debug(`Checking filter settings for user ${session.id} (${session.data.username})`);
      let filters = session.data.filters;
      if (!filters) {
        filters = {
          maxprice: ['Max. Price', 'Any'],
          minhd: ['Min. HD', 'Any'],
          minram: ['Min. RAM', 'Any'],
          cputype: ['CPU Type', 'Any']
        };
      }

      // Filters contains the default values, we can access them directly
      const { maxprice, minhd, minram, cputype } = filters;
      if (
        (maxprice[1] === "Any" || server.price * 1 <= maxprice[1] * 1) &&
        (minhd[1] === "Any" || server.hdd_count * 1 >= minhd[1] * 1) &&
        (minram[1] === "Any" || server.ram_size * 1 >= minram[1] * 1) &&
        (cputype[1] === "Any" || server.cpu.indexOf(cputype[1]) > -1)
      ) {
        resetNotificationCounterIfNeeded(session.id);
        if (session.data.premium === 0 && notificationCounters[session.id].daily_notifications >= max_daily_notifications) {
          logger.info(`User ${session.id} (${session.data.username}) has reached the daily notification limit.`);
          continue;
        }
        else if (session.data.premium === 0) {
          notificationCounters[session.id].daily_notifications += 1;
          saveJSONToFile(notification_filename, notificationCounters);
        }

        logger.info(`Server ${server.key} matches filters for user ${session.id} (${session.data.username})`);
        await bot.telegram.sendMessage(session.id, server_text, reply_format);
      }
    } catch (sessionError) {
      logger.error(`Error occurred for user ${session.id}: ${sessionError.code ? sessionError.code : 'N/A'}`);
      logger.error(`- Message: ${sessionError.message}`);
      logger.error(`- On: ${JSON.stringify(sessionError.on)}`);
    }
  }
}

// function to process pending notifications that are due
const processPendingNotifications = async () => {
  // // Only runs at minute 00 or 30.
  // const nowCheck = new Date();
  // const minutes = nowCheck.getMinutes();
  // if (![0, 30].includes(minutes)) {
  //   logger.debug(`Not processing pending notifications because it's not the 00 or 30 minutes.`);
  //   return;
  // }

  // Exit if there are no pending notifications
  const pendingData = readPendingNotifications();
  if (!pendingData.pending || pendingData.pending.length === 0) {
    logger.debug(`No pending notifications to process.`);
    return;
  }

  const now = Date.now();
  const notificationsToSend = [];
  const remainingNotifications = [];

  // Separate notifications that are due from those that are still pending
  for (const notification of pendingData.pending) {
    if (now >= notification.notify_at) {
      notificationsToSend.push(notification);
    } else {
      remainingNotifications.push(notification);
    }
  }

  if (notificationsToSend.length === 0) {
    logger.debug(`No notifications to send.`);
    return;
  }

  // Save file containing only the remaining notifications
  savePendingNotifications({ pending: remainingNotifications });

  logger.info(`Processing ${notificationsToSend.length} pending notification(s) for regular users.`);

  // Re-read sessions and notification counters
  try {
    sessions = JSON.parse(fs.readFileSync(session_filename))['sessions'];
  } catch(error) {
    logger.error(`Error reading ${session_filename} for pending notifications.`);
    return;
  }

  try {
    notificationCounters = JSON.parse(fs.readFileSync(notification_filename));
  } catch (error) {
    notificationCounters = {};
  }

  // Get current regular users
  let regularUsers = sessions.filter(session => session.data.premium !== 1);

  // Send all due notifications
  for (const notification of notificationsToSend) {
    try {
      logger.info(`Notifying ${regularUsers.length} regular users for server ${notification.server.key} (delayed notification).`);
      await sendNotifications(regularUsers, notification.server);
    } catch (error) {
      logger.error(`Error processing pending notification for server ${notification.server.key}: ${error.message}`);
    }
  }

  logger.info(`Sent ${notificationsToSend.length} pending notification(s), ${remainingNotifications.length} still pending.`);
}

// main loop every ${timeout} seconds
logger.info('Hetzner Auction Servers notifier started.');

// Use recursive setTimeout instead of setInterval to ensure async operations complete before next iteration
const checkForServers = async function() {
  try {
    // First, process any pending notifications that are due
    await processPendingNotifications();

    logger.info('Checking for new servers');

    // get remote list
    const response = await axios.get(live_data_remote, headers);
    remoteServers = response.data;

    // get local list
    try {
      let data = fs.readFileSync(local_filename);
      localServers = JSON.parse(data);
    } catch(error) {
      localServers = remoteServers;
    }

    logger.debug('Remote servers hash: ' + objectHash(remoteServers));
    logger.debug('Local servers hash: ' + objectHash(localServers));

    // compare hash of every list
    if (objectHash(remoteServers) !== objectHash(localServers)) {
      // get the difference of both lists
      newServers = remoteServers.server.filter(x => !localServers.server.find(y => y.key === x.key));

      // do more job if there are new servers
      if (newServers.length > 0) {
        logger.info(`Found ${newServers.length} servers`);

        // save the new list for future executions
        fs.writeFileSync(local_filename, JSON.stringify(remoteServers));

        // read session file for individual notifications
        try {
          sessions = JSON.parse(fs.readFileSync(session_filename))['sessions'];
        } catch(error) {
          logger.error(`Error reading ${session_filename}. Skipping individual notifications.`);
        }

        // read notification counters
        try {
          notificationCounters = JSON.parse(fs.readFileSync(notification_filename));
        } catch (error) {
          notificationCounters = {};
        }

        // Calculate a single notify_at time for all notifications in this batch
        const notifyAt = Date.now() + (premium_delay * 60 * 1000);
        
        // Array to collect pending notifications for this batch
        const pendingNotificationsToAdd = [];

        // loop on every new server
        for (const server of newServers) {
          // Generate message text for Telegram channel
          let server_text = composeMessage(server);

          // send them individually to Telegram channel
          logger.debug(`Sending message to ${telegram_chatid}: ${server_text}`);
          let message = 'Via @HetznerAuctionServersBot:\n' + server_text + 'You can also talk privately with [the bot](https://t.me/HetznerAuctionServersBot) to create your own filters and/or unlock premium features.\n';
          await bot.telegram.sendMessage(telegram_chatid, message, reply_format);

          // find premium and regular users
          let premiumUsers = sessions.filter(session => session.data.premium === 1);
          let regularUsers = sessions.filter(session => session.data.premium !== 1);

          // send notifications to premium users immediately
          logger.info(`Notifying ${premiumUsers.length} premium users immediately.`);
          await sendNotifications(premiumUsers, server);

          // Add notification to pending array for regular users (only store server data, text will be generated later)
          logger.info(`Enqueuing notification for ${regularUsers.length} regular users (server ${server.key}). Will be sent in ${premium_delay} minutes.`);
          pendingNotificationsToAdd.push({
            server_key: server.key,
            server: server,
            notify_at: notifyAt
          });
        }

        // After processing all new servers, add all pending notifications to the file at once
        if (pendingNotificationsToAdd.length > 0) {
          const pendingData = readPendingNotifications();
          
          if (!pendingData.pending) {
            pendingData.pending = [];
          }
          
          // Check for duplicates and add only new notifications
          const existingServerKeys = new Set((pendingData.pending || []).map(n => {
            return n.server_key || (n.server && n.server.key);
          }));
          
          let addedCount = 0;
          for (const notification of pendingNotificationsToAdd) {
            const serverKey = notification.server_key || (notification.server && notification.server.key);
            if (!existingServerKeys.has(serverKey)) {
              pendingData.pending.push(notification);
              existingServerKeys.add(serverKey);
              addedCount++;
            } else {
              logger.debug(`Regular user notification already enqueued for server ${serverKey}, skipping duplicate`);
            }
          }
          
          if (addedCount > 0) {
            savePendingNotifications(pendingData);
            logger.info(`Added ${addedCount} pending notification(s) to queue. All will be sent at ${new Date(notifyAt).toISOString()}.`);
          }
        }
      } else {
        logger.debug('New data received but no new servers found');
      }
    } else {
      logger.debug('No new data in remote server list');
    }
  }
  catch (error) {
    if (error.isAxiosError) {
      logger.error('Axios Error occurred: ');
      logger.error(`- Message: ${error.message}`);
      logger.error(`- Status: ${error.response ? error.response.status : 'N/A'}`);
      logger.error(`- Status Text: ${error.response ? error.response.statusText : 'N/A'}`);
      logger.error(`- Config URL: ${error.config.url}`);
      logger.error(`- Request Data: ${JSON.stringify(error.config.data)}`);
      if (error.response) {
        logger.error(`- Response Data: ${JSON.stringify(error.response.data)}`);
      }
    } else {
      logger.error('Full error object properties:');
      Object.getOwnPropertyNames(error).forEach(key => {
        try {
          const value = error[key];
          logger.error(`- ${key}: ${JSON.stringify(value)}`);
        } catch (jsonError) {
          logger.error(`- ${key}: [Unserializable]`);
        }
      });
    }
  }
  
  // Schedule next execution after current one completes
  setTimeout(checkForServers, timeout * 1000);
};

// Start the first execution
checkForServers();
