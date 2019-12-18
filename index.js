const fs       = require('fs'),
      axios    = require('axios'),
      telegraf = require('telegraf');
      winston  = require('winston');

const headers = {
       'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.79 Safari/537.36'
      },
      live_data_remote = 'https://www.hetzner.com/a_hz_serverboerse/live_data.json',
      telegram_chatid  = process.env.TELEGRAM_CHATID,
      telegram_key     = process.env.TELEGRAM_KEY;

let localServers  = {},
    remoteServers = {},
    newServers    = {};

const bot = new telegraf(telegram_key)

const logger = winston.createLogger({
    transports: [
        new winston.transports.Console({
              level: 'debug',
              handleExceptions: true,
              format: winston.format.combine(
                winston.format.timestamp({format: 'YYYY-MM-DD HH:mm:ss'}),
                winston.format.printf(info => `${info.timestamp} ${info.level}: ${info.message}`+(info.splat!==undefined?`${info.splat}.`:'.'))
              )
            })
    ]
  });

logger.info('Checking for new servers');
axios.get(live_data_remote, headers)
  .then(response => {
    remoteServers = response.data;
  })
  .then(response => new Promise((resolve, reject) => {
    try {
      data = fs.readFileSync('live_data.json');
      localServers = JSON.parse(data);
    } catch(error) {
      localServers = remoteServers;
    }
    return resolve();
  }))
  .then(() => new Promise((resolve, reject) => {
    logger.debug(`Remote servers hash: ${remoteServers.hash}`);
    logger.debug(`Local servers hash: ${localServers.hash}`);
    if (remoteServers.hash !== localServers.hash) {
      newServers = remoteServers.server.filter(x => !localServers.server.find(y => y.key === x.key));
      if (newServers.length > 0) {
        logger.info(`Found ${ newServers.length } servers`);
        try {
          fs.writeFileSync('live_data.json', JSON.stringify(remoteServers));
        } catch(error) {
          return reject('Error: Cannot write local server list');
        }

        try {
          let message = `Found new *${ newServers.length }* server(s):\n\n`;
          for (const server of newServers) {
            message += `*ID:* ${server.key}\n*Name:* ${server.name}\n*Description:* ${server.freetext}\n*Price:* ${parseFloat(server.price).toFixed(2)} €/month\n*Setup Prize:* ${server.setup_prize || '0'} €\n*Expires:* ${server.next_reduce_hr} left\n\n`;
          }
          message += 'Open the [server auction page](https://www.hetzner.com/sb?country=ot) and type the *ID* in the search box to find the details.\n';
          logger.debug(`Sending message: ${message}`);
          bot.telegram.sendMessage(telegram_chatid, message, {parse_mode: 'Markdown'});
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
  .catch((error) => {
    if (error.isAxiosError) {
      logger.error('Error: Cannot fetch remote server list');
    } else {
      logger.error(error);
    }
  });
