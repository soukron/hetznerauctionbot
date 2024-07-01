// include requirements
const fs               = require('fs'),
      axios            = require('axios'),
      telegraf         = require('telegraf');
      winston          = require('winston');
      objectHash       = require('object-hash');
      humanizeDuration = require("humanize-duration");

// configuration variables with default values
const loglevel         = process.env.LOGLEVEL || 'info',
      headers          = {
       'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36'
      },
      live_data_remote = 'https://www.hetzner.com/_resources/app/jsondata/live_data_sb.json',
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

  return message;
}

// main loop every ${timeout} seconds
logger.info('Hetzner Auction Servers notifier started.');
setInterval(async function() {
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

        // loop on every new server
        for (const server of newServers) {
          let server_text = composeMessage(server);

          // send them individually to Telegram channel
          logger.debug(`Sending message to ${telegram_chatid}: ${server_text}`);
          let message = 'Via @HetznerAuctionServersBot:\n' + server_text +  'You can also talk privately with [the bot](https://t.me/HetznerAuctionServersBot) to create your own filters.\n';
          await bot.telegram.sendMessage(telegram_chatid, message, reply_format);

          // find users with matching filters
          for (const session of sessions) {
            if (session.data.notifications == false) {
              logger.debug(`Skipping filter settings for user ${session.id} (${session.data.username})`);
              continue;
            }
            
            logger.debug(`Checking filter settings for user ${session.id} (${session.data.username})`);
            let filters = session.data.filters;
            if (
              (filters.maxprice[1] === "Any" || server.price*1 <= filters.maxprice[1]*1) &&
              (filters.minhd[1] === "Any" || server.hdd_count*1 >= filters.minhd[1]*1) &&
              (filters.minram[1] === "Any" || server.ram_size*1 >= filters.minram[1]*1) &&
              (filters.cputype[1] === "Any" || server.cpu.indexOf(filters.cputype[1]) > -1)
            ) {
              logger.debug(`Server ${server.key} matches filters for user ${session.id} (${session.data.username})`);
              await bot.telegram.sendMessage(session.id, server_text, reply_format);
            }
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
      logger.error('Axios Error ocurred: ');
      logger.error(`- Message: ${error.message}`);
      logger.error(`- Status: ${error.response ? error.response.status : 'N/A'}`);
      logger.error(`- Status Text: ${error.response ? error.response.statusText : 'N/A'}`);
      logger.error(`- Config URL: ${error.config.url}`);
      logger.error(`- Request Data: ${JSON.stringify(error.config.data)}`);
      if (error.response) {
        logger.error(`- Response Data: ${JSON.stringify(error.response.data)}`);
      }
    } else {
      logger.error(`Error occurred: ${error.code}`);
      logger.error(`- Message: ${error.message}`);
      logger.error(`- On: ${JSON.stringify(error.on)}`);
    }
    // logger.error('Full error object properties:');
    // Object.getOwnPropertyNames(error).forEach(key => {
    //   try {
    //     const value = error[key];
    //     logger.error(`- ${key}: ${JSON.stringify(value)}`);
    //   } catch (jsonError) {
    //     logger.error(`- ${key}: [Unserializable]`);
    //   }
    // });
  }
}, timeout * 1000);