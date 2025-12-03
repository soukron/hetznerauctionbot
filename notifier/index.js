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
      test_mode        = process.env.TEST_MODE === 'true' || process.env.TEST_MODE === '1',
      test_user_ids    = process.env.TEST_USER_IDS ? process.env.TEST_USER_IDS.split(',').map(id => id.trim()) : [],
      file_suffix      = test_mode ? '_test' : '',
      session_filename = 'data/session.json',
      pending_notifications_filename = `data/pending_notifications${file_suffix}.json`,
      free_batch_schedule = process.env.FREE_BATCH_SCHEDULE || '00 */6 * * *';

// other variables
let localServers   = {},
    remoteServers  = {},
    newServers     = {},
    sessions       = [],
    instructions_text_single = '\nOpen the [server auction page](https://www.hetzner.com/sb?country=ot) and type the *ID* in the search box to find the details.\n',
    instructions_text_grouped = '\nFor each server, open the [server auction page](https://www.hetzner.com/sb?country=ot) and type the *ID* in the search box to find the details.\n',
    footer_text = '\nDisable notifications and/or change the filters in your settings (use /start command) to stop receiving notifications.'
    
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
const composeMessage = (server, append_instructions = true, append_footer = true) => {
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
  message += `⏲️ *Next reduce time:* ${timeRemaining}\n`;

  if (append_instructions) message += instructions_text_single;
  if (append_footer) message += footer_text;

  return message;
}

// compose a grouped message from multiple servers (max 5, ordered by price)
const composeGroupedMessage = (servers) => {
  if (servers.length === 0) return '';
  
  // Sort by price (ascending)
  const sortedServers = [...servers].sort((a, b) => parseFloat(a.price) - parseFloat(b.price));
  
  // Take maximum 5
  const serversToShow = sortedServers.slice(0, 5);
  
  // Compose the message
  let message = `📦 *Found ${serversToShow.length} server${serversToShow.length > 1 ? 's' : ''} matching your filters:*\n\n`;
  serversToShow.forEach((server, index) => {
    // Use composeMessage without instructions and footer for each server
    const serverMessage = composeMessage(server, false, false);
    // Add numbering prefix
    message += `${serverMessage}`;
    if (index < serversToShow.length - 1) {
      message += 'n---\n\n';
    }
  });
  
  message += instructions_text_grouped;
  message += footer_text;
  
  return message;
}

// function to save JSON to file
const saveJSONToFile = (filename, jsonObject) => {
  fs.writeFileSync(filename, JSON.stringify(jsonObject, null, 2));
}

// function to check if current time matches cron schedule
// Supports basic cron syntax: minute hour * * *
// Examples: "00 */6 * * *" (every 6 hours at minute 00), "00 0,6,12,18 * * *" (at 00:00, 06:00, 12:00, 18:00)
const shouldRunBatch = (cronSchedule) => {
  const parts = cronSchedule.trim().split(/\s+/);
  if (parts.length !== 5) {
    logger.error(`Invalid cron schedule format: ${cronSchedule}. Expected format: "minute hour * * *"`);
    return false;
  }

  const [minutePattern, hourPattern] = parts;
  const now = new Date();
  const currentMinute = now.getMinutes();
  const currentHour = now.getHours();

  // Check minute
  const minuteMatch = checkCronField(minutePattern, currentMinute);
  if (!minuteMatch) return false;

  // Check hour
  const hourMatch = checkCronField(hourPattern, currentHour);
  return hourMatch;
}

// Helper function to check if a value matches a cron field pattern
const checkCronField = (pattern, value) => {
  // Exact match - compare as numbers to handle "00" vs "0"
  if (parseInt(pattern) === value) return true;
  
  // Wildcard
  if (pattern === '*') return true;
  
  // Step values: */N (every N)
  if (pattern.startsWith('*/')) {
    const step = parseInt(pattern.substring(2));
    return value % step === 0;
  }
  
  // List: 0,6,12,18
  if (pattern.includes(',')) {
    const values = pattern.split(',').map(v => parseInt(v.trim()));
    return values.includes(value);
  }
  
  // Range: 0-23
  if (pattern.includes('-')) {
    const [start, end] = pattern.split('-').map(v => parseInt(v.trim()));
    return value >= start && value <= end;
  }
  
  return false;
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

// function to filter users based on test mode
const filterTestUsers = (users, userType = '') => {
  if (test_mode && test_user_ids.length > 0) {
    const filtered = users.filter(session => test_user_ids.includes(session.id));
    if (filtered.length > 0 || users.length > 0) {
      logger.info(`TEST MODE: Filtered ${userType} users from ${users.length} to ${filtered.length} test users.`);
    }
    return filtered;
  }
  return users;
}

// function to check if server matches user filters
const serverMatchesFilters = (server, filters) => {
  if (!filters) {
    filters = {
      maxprice: ['Max. Price', 'Any'],
      minhd: ['Min. HD', 'Any'],
      minram: ['Min. RAM', 'Any'],
      cputype: ['CPU Type', 'Any']
    };
  }

  const { maxprice, minhd, minram, cputype } = filters;
  return (
    (maxprice[1] === "Any" || server.price * 1 <= maxprice[1] * 1) &&
    (minhd[1] === "Any" || server.hdd_count * 1 >= minhd[1] * 1) &&
    (minram[1] === "Any" || server.ram_size * 1 >= minram[1] * 1) &&
    (cputype[1] === "Any" || server.cpu.indexOf(cputype[1]) > -1)
  );
}

// function to process batched notifications for free users
const processBatchedNotifications = async () => {
  // Check if it's time to run based on cron schedule
  const shouldRun = shouldRunBatch(free_batch_schedule);
  logger.debug(`Checking batch schedule: ${free_batch_schedule}, current time: ${new Date().toISOString()}, shouldRun: ${shouldRun}`);
  if (!shouldRun) {
    return;
  }

  logger.info('Processing batched notifications for free users.');

  // Read pending notifications
  const pendingData = readPendingNotifications();
  if (!pendingData.pending || pendingData.pending.length === 0) {
    logger.debug('No pending servers to process.');
    return;
  }

  // Re-read sessions
  try {
    sessions = JSON.parse(fs.readFileSync(session_filename))['sessions'];
  } catch(error) {
    logger.error(`Error reading ${session_filename} for batched notifications.`);
    return;
  }

  // Get free users (non-premium with notifications enabled)
  let freeUsers = sessions.filter(session => 
    session.data.premium !== 1 && 
    session.data.notifications !== false
  );

  // Filter to test users only if in test mode
  freeUsers = filterTestUsers(freeUsers, 'free');

  if (freeUsers.length === 0) {
    logger.debug('No free users to notify.');
    // Still clear pending list
    savePendingNotifications({ pending: [] });
    return;
  }

  // Extract servers from pending notifications
  const pendingServers = pendingData.pending.map(n => n.server);

  // Process each free user
  let notificationsSent = 0;
  for (const user of freeUsers) {
    try {
      // Filter servers that match user's criteria
      const matchingServers = pendingServers.filter(server => 
        serverMatchesFilters(server, user.data.filters)
      );

      if (matchingServers.length === 0) {
        continue;
      }

      // Generate grouped message (max 5 servers, sorted by price)
      const groupedMessage = composeGroupedMessage(matchingServers);

      if (groupedMessage) {
        logger.info(`Sending batched notification to user ${user.id} (${user.data.username || 'unknown'}) with ${Math.min(matchingServers.length, 5)} servers.`);
        await bot.telegram.sendMessage(user.id, groupedMessage, reply_format);
        notificationsSent++;
      }
    } catch (error) {
      logger.error(`Error sending batched notification to user ${user.id}: ${error.code ? error.code : 'N/A'}`);
      logger.error(`- Message: ${error.message}`);
    }
  }

  // Clear pending list after processing
  savePendingNotifications({ pending: [] });
  logger.info(`Processed batched notifications: sent ${notificationsSent} messages to free users, cleared ${pendingServers.length} pending servers.`);
}

// main loop every ${timeout} seconds
if (test_mode) {
  logger.info(`Hetzner Auction Servers notifier started in TEST MODE.`);
  logger.info(`Test user IDs: ${test_user_ids.length > 0 ? test_user_ids.join(', ') : 'none specified (will process all users)'}`);
  logger.info(`Using shared session file: session.json (read-only)`);
} else {
  logger.info('Hetzner Auction Servers notifier started.');
}

// Use recursive setTimeout instead of setInterval to ensure async operations complete before next iteration
const checkForServers = async function() {
  try {
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

        // Array to collect pending servers for free users
        const pendingServersToAdd = [];

        // loop on every new server
        for (const server of newServers) {
          // Generate message text for Telegram channel
          let server_text = composeMessage(server);

          // send them individually to Telegram channel
          logger.debug(`Sending message to ${telegram_chatid}: ${server_text}`);
          let message = 'Via @HetznerAuctionServersBot:\n' + server_text + 'You can also talk privately with [the bot](https://t.me/HetznerAuctionServersBot) to create your own filters and/or unlock premium features.\n';
          await bot.telegram.sendMessage(telegram_chatid, message, reply_format);

          // find premium and free users
          let premiumUsers = sessions.filter(session => session.data.premium === 1);
          let freeUsers = sessions.filter(session => session.data.premium !== 1);

          // Filter to test users only if in test mode
          premiumUsers = filterTestUsers(premiumUsers, 'premium');
          freeUsers = filterTestUsers(freeUsers, 'free');

          // send notifications to premium users immediately
          logger.info(`Notifying ${premiumUsers.length} premium users immediately.`);
          await sendNotifications(premiumUsers, server);

          // Add server to pending list for free users (will be processed in batches)
          logger.info(`Adding server ${server.key} to pending list for ${freeUsers.length} free users.`);
          pendingServersToAdd.push({
            server: server,
            detected_at: Date.now()
          });
        }

        // After processing all new servers, add all pending servers to the file at once
        if (pendingServersToAdd.length > 0) {
          const pendingData = readPendingNotifications();
          
          if (!pendingData.pending) {
            pendingData.pending = [];
          }
          
          // Check for duplicates and add only new servers
          const existingServerKeys = new Set((pendingData.pending || []).map(n => {
            return n.server && n.server.key;
          }));
          
          let addedCount = 0;
          for (const notification of pendingServersToAdd) {
            const serverKey = notification.server && notification.server.key;
            if (serverKey && !existingServerKeys.has(serverKey)) {
              pendingData.pending.push(notification);
              existingServerKeys.add(serverKey);
              addedCount++;
            } else {
              logger.debug(`Server ${serverKey} already in pending list, skipping duplicate`);
            }
          }
          
          if (addedCount > 0) {
            savePendingNotifications(pendingData);
            logger.info(`Added ${addedCount} server(s) to pending list for batch processing.`);
          }
        }
      } else {
        logger.debug('New data received but no new servers found');
      }
    } else {
      logger.debug('No new data in remote server list');
    }

    // Finally process batched notifications for free users if it's time
    await processBatchedNotifications();
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
