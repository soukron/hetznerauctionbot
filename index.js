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
      telegram_chatid  = process.env.TELEGRAM_CHATID,
      telegram_key     = process.env.TELEGRAM_KEY,
      timeout          = process.env.TIMEOUT || 60;

// other variables
let localServers  = {},
    remoteServers = {},
    newServers    = {};

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
      data = fs.readFileSync(local_filename);
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

        // send them individually to Telegram channel
        try {
          for (const server of newServers) {
            let message = `New server added:\n\n`;
            message += `*ID:* ${server.key}\n`;
            message += `*Name:* ${server.name}\n`;
            message += `*Description:* ${server.freetext}\n`;
            message += `*Price:* ${parseFloat(server.price).toFixed(2)} €/month (excl. VAT)\n`;
            message += `*Setup Prize:* ${server.setup_prize || '0'} €\n`;
            message += `*Expires:* ${server.next_reduce_hr} left\n\n`;
            message += 'Open the [server auction page](https://www.hetzner.com/sb?country=ot) and type the *ID* in the search box to find the details.\n';

            logger.debug(`Sending message: ${message}`);
            bot.telegram.sendMessage(telegram_chatid, message, {parse_mode: 'Markdown', disable_web_page_preview: true});
          }
        } catch(error) {
          return reject('Error: Cannot send the message to Telegram channel');
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
