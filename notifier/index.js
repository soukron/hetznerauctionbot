// include requirements
const fs       = require('fs'),
      axios    = require('axios'),
      telegraf = require('telegraf');
      winston  = require('winston');

// configuration variables with default values
const loglevel         = process.env.LOGLEVEL || 'info',
      headers          = {
       'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36'
      },
      live_data_remote = 'https://www.hetzner.com/a_hz_serverboerse/live_data.json',
      local_filename   = 'data/live_data.json',
      reply_format     = {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      },
      telegram_chatid  = process.env.TELEGRAM_CHATID,
      telegram_key     = process.env.TELEGRAM_KEY,
      timeout          = process.env.TIMEOUT || 60,
      session_filename = 'data/session.json';

// other variables
let localServers  = {},
    remoteServers = {},
    newServers    = {},
    sessions      = [];

// initialize some components (bot, logger, etc.)
const bot = new telegraf(telegram_key)
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
  message += `🧮 *RAM:* ${server.ram_hr}\n`;
  message += `💽 *HDD:* ${server.hdd_hr}\n`;
  message += `💵 *Price:* ${parseFloat(server.price).toFixed(2)} €/month (excl. VAT)\n`;
  message += `📋 *Description:* ${server.freetext}\n`;
  message += `⏲️ *Expires:* ${server.next_reduce_hr} left\n\n`;
  message += 'Open the [server auction page](https://www.hetzner.com/sb?country=ot) and type the *ID* in the search box to find the details.\n';

  return message;
}

// main loop every ${timeout} seconds
logger.info('Hetzner Auction Servers notifier started.');
setInterval(function() {
  logger.info('Checking for new servers');

  // get remote list
  axios.get(live_data_remote, headers)
  .then(response => {
    remoteServers = response.data;
  })

  // get local list
  .then(response => new Promise((resolve, reject) => {
    try {
      let data = fs.readFileSync(local_filename);
      localServers = JSON.parse(data);
    } catch(error) {
      localServers = remoteServers;
    }
    return resolve();
  }))

  // check if there are new servers and notify them in Telegram channel
  .then(() => new Promise((resolve, reject) => {
    logger.debug(`Remote servers hash: ${remoteServers.hash}`);
    logger.debug(`Local servers hash: ${localServers.hash}`);

    // compare hash of every list
    if (remoteServers.hash !== localServers.hash) {

      // get the difference of both lists
      newServers = remoteServers.server.filter(x => !localServers.server.find(y => y.key === x.key));

      // do more job if there are new servers
      if (newServers.length > 0) {
        logger.info(`Found ${ newServers.length } servers`);

        // save the new list for future executions
        try {
          fs.writeFileSync(local_filename, JSON.stringify(remoteServers));
        } catch(error) {
          return reject('Error: Cannot write local server list');
        }

        // read session file for individual notifications
        try {
          sessions = JSON.parse(fs.readFileSync(session_filename))['sessions'];
        } catch(error) {
          logger.error(`Error reading ${session_filename}. Skipping individual notifications.`);
        }

        // loop on every new server
        for (const server of newServers) {
          let server_text = composeMessage(server);

          // send them individually to Telegram channel
          logger.debug(`Sending message to ${telegram_chatid}: ${server_text}`);  
          try {
            let message = 'Via @HetznerAuctionServersBot:\n' + server_text +  'You can also talk privately with [the bot](https://t.me/HetznerAuctionServersBot) to create your own filters.\n';
            bot.telegram.sendMessage(telegram_chatid, message, reply_format);
          } catch(error) {
            return reject('Error: Cannot send the message to Telegram channel');
          }
          
          // find users with matching filters
          sessions.forEach(session => {
            logger.debug(`Checking filter settings for user ${session.id}`);
            let filters = session.data.filters;
            if (
              (filters.maxprice[1] === "Any" || server.price*1 <= filters.maxprice[1]*1) &&
              (filters.minhd[1] === "Any" || server.hdd_count*1 >= filters.minhd[1]*1) &&
              (filters.minram[1] === "Any" || server.ram*1 >= filters.minram[1]*1) &&
              (filters.cputype[1] === "Any" || server.cpu.indexOf(filter.cputype[1]) > -1)
            ) {
              logger.debug(`Server ${server.key} matches filters for user ${session.id}`);
              try {
                bot.telegram.sendMessage(session.id, server_text, reply_format);
              } catch(error) {
                return reject(`Error: Cannot send the message to user ${session.id}.`);
              }      
            }
          });
        }
      } else {
        logger.debug('New data received but no new servers found');
      }
    } else {
      logger.debug('No new data in remote server list');
    }
    return resolve();
  }))

  // catch any other possible error in the promises
  .catch((error) => {
    if (error.isAxiosError) {
      logger.error('Error: Cannot fetch remote server list');
    } else {
      logger.error(error);
    }
  });
}, timeout * 1000);
