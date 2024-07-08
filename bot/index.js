// include requirements
const { findServersForUser } = require('./notifier'),
      Telegraf               = require('telegraf'),
      TelegrafInlineMenu     = require('telegraf-inline-menu'),
      TelegrafSession        = require('telegraf-session-local'),
      winston                = require('winston');

// configuration variables with default values
const loglevel         = process.env.LOGLEVEL || 'info',
      reply_format     = {
        parse_mode: 'Markdown',
        disable_web_page_preview: true
      },
      reply_timeout      = process.env.REPLY_TIMEOUT || 5,
      session_filename   = 'data/session.json',
      local_filename     = 'data/live_data.json',
      telegram_key       = process.env.TELEGRAM_KEY,
      max_daily_searches = process.env.MAX_SEARCHES || 5,
      max_results        = process.env.MAX_RESULTS || 3,
      abs_max_results    = process.env.ABS_MAX_RESULTS || 10;

// initialize some components (bot, winston, etc.)
const bot = new Telegraf(telegram_key);
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

// function to initialize or reset search count
const initializeOrResetSearchCount = (ctx) => {
  const today = new Date().toISOString().slice(0, 10);
  if (!ctx.session.searchDate || (ctx.session.searchDate && ctx.session.searchDate !== today)) {
    ctx.session.searchDate = today;
    ctx.session.searchCount = 0;
  }
}

// function to reply with auto-delete
const replyWithAutoDelete = (ctx, message, timeoutMultiplier = 1) => {
  ctx.reply(message, reply_format).then(({ message_id }) => {
    setTimeout(() => ctx.deleteMessage(message_id), reply_timeout * timeoutMultiplier * 1000);
  });
}

// search filters to create submenus programatically
const filters = [
  {
    'name': 'maxprice',
    'title': 'Max. Price',
    'values': ['Any', '30', '40', '50', '60', '70', '80', '90', '100', '110', '120', '130', '140', '150', '200'],
    'menu': new TelegrafInlineMenu('Set the max. price (excl. VAT):'),
    'joinLastRow': false
  },
  {
    'name': 'minhd',
    'title': 'Min. HD',
    'values': ['Any', '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '14', '15'],
    'menu': new TelegrafInlineMenu('Set the min. number of disks:'),
    'joinLastRow': true
  },
  {
    'name': 'minram',
    'title': 'Min. RAM',
    'values': ['Any', '2', '4', '8', '12', '16', '24', '32', '48', '64', '96', '128', '256', '512', '768'],
    'menu': new TelegrafInlineMenu('Set the min. RAM size in GB:'),
    'joinLastRow': true
  },
  {
    'name': 'cputype',
    'title': 'CPU Type',
    'values': ['Any', 'Intel', 'AMD'],
    'menu': new TelegrafInlineMenu('Set the preferred CPU type:'),
    'joinLastRow': false
  },
];

// settings submenu definition
const filtersMenu = new TelegrafInlineMenu('Choose an option to change your search preferences:');
// settings -> button to see current settings
filtersMenu.simpleButton('📄 View current filters', 'configure-filters', {
  doFunc: ctx => {
    let message = 'This is the current filters configuration:\n';
    try {
      for (const [name, filter] of Object.entries(ctx.session.filters)) {
        message += ` - *${filter[0]}*: ${filter[1]}\n`;
      }
    } catch(error) {
      message = 'You don\'t have defined your own filters yet.';
    }
    replyWithAutoDelete(ctx, message);
  }
});
// settings -> submenus for each filter option
filters.forEach(item => {
  // create the filter submenu
  item.menu.select(`set-${item.name}`, item.values, {
    setFunc: (ctx, key) => {
      // set the value in the session
      logger.debug(`${ctx.update.callback_query.from.id} (${ctx.update.callback_query.from.username}) sets ${item.name} => ${key}`);
      ctx.session.username = ctx.update.callback_query.from.username;
      ctx.session.filters[item.name] = [item.title, key];
    },
    isSetFunc: (ctx, key) => {
      try {
        // return (true) if user is viewing this specific value
        return ctx.session.filters[item.name][1] === key;
      }
      catch (error) { 
        // initialize filters in session if error
        if (typeof ctx.session.filters === 'undefined') {
          ctx.session.filters = {};
          filters.forEach(filter => {
            ctx.session.filters[filter.name] = [filter.title, filter.values[0]];
          });
        }
        // return (true) if user is viewing this specific value after initialize
        return ctx.session.filters[item.name][1] === key;
      }
    }
  });
  // add the filter submenu to the settings submenu
  filtersMenu.submenu(item.title, item.name, item.menu, {joinLastRow: item.joinLastRow});
});

// main menu
const menu = new TelegrafInlineMenu('Choose an option:');
menu.setCommand('start');
menu.submenu('🔧 Filters', 'filters', filtersMenu);
menu.simpleButton('🔍 Search now', 'search-now', {
  doFunc: ctx => {
    initializeOrResetSearchCount(ctx); // Ensure search count is up-to-date

    // Check if user is premium
    const isPremium = ctx.session.premium === 1;

    if (!isPremium && ctx.session.searchCount >= max_daily_searches) {
      replyWithAutoDelete(ctx, `You have reached the daily limit of ${max_daily_searches} searches. Please try again tomorrow or unlock Premium features.`, 2);
    } else {
      if (!isPremium) {
        ctx.session.searchCount++;
      }

      const servers = findServersForUser(ctx.update.callback_query.from.id, local_filename, session_filename);
      if (servers.length === 0) {
        replyWithAutoDelete(ctx, 'There are no active servers that match your criteria.', 2);
      } else {
        let messages = [];
        let max_slice = (isPremium? abs_max_results:max_results);

        messages.push(`Here are the most recent ${max_slice} servers (out of ${servers.length}):`);
        servers.slice(0, max_slice).forEach(server => messages.push(server));
        if (!isPremium) {
          messages.push(`You can do ${max_daily_searches - ctx.session.searchCount} more searches today.`);
        }
        replyWithAutoDelete(ctx, messages.join('\n'), 2);
      }
    }
  },
  joinLastRow: true
});
menu.toggle('Notifications', 'notifications', {
  isSetFunc: ctx => ctx.session.notifications,
  setFunc: (ctx, newState) => {
    ctx.session.notifications = newState;
    logger.debug(`${ctx.update.callback_query.from.id} (${ctx.update.callback_query.from.username}) sets notifications => ${newState}`);
  }
});
menu.simpleButton('ℹ️ Help', 'help', {
  doFunc: ctx => {
    let message = 'This is a helper bot for [Hetzner Auction Servers channel]';
    message += '(https://t.me/hetznerauctionservers).\n\n*INSTRUCTIONS*:\n';
    message += ' - Use /start to show the main menu at any moment.\n';
    message += ' - Use the Settings menu to set your search preferences and you ';
    message += 'will get notified for new servers matching your criteria.\n';
    message += ' - Messages from the bot may be deleted automatically after ';
    message += 'some time in order to keep the chat history clean.\n';
    message += ' - Disable the notifications at your convenience.\n';
    message += ' - Premium features available.\n';
    message += ' - If you need help you can contact [@Soukron](https://t.me/soukron).';

    replyWithAutoDelete(ctx, message, 2);
  }
});
// menu.simpleButton('🏅 Premium features', 'premium', {
//   doFunc: ctx => {
//     let nonPremiumMessage = 'Consider donating to the developer to enjoy some nice to have features like:\n';
//     nonPremiumMessage += ' - receive unlimited daily notifications.\n';
//     nonPremiumMessage += ' - receive the notifications 15 minutes before non-premium users.\n';
//     nonPremiumMessage += ' - perform unlimited searches per day based on your filters.\n';
//     nonPremiumMessage += ' - increase the number of results in searches.\n\n';

//     let premiumMessage = 'Thanks for supporting the developer. As a *premium member* you can:\n';
//     premiumMessage += ' - receive unlimited daily notifications.\n';
//     premiumMessage += ' - receive the notifications 15 minutes before non-premium users.\n';
//     premiumMessage += ' - perform unlimited searches per day based on your filters.\n';
//     premiumMessage += ' - increase the number of results in searches.\n\n';
//     premiumMessage += 'Thank you!'

//     if (ctx.session.premium === 1) {
//       replyWithAutoDelete(ctx, premiumMessage, 2);
//     }
//     else {
//       replyWithAutoDelete(ctx, nonPremiumMessage, 2);
//     }
//   }
// });

// set bot options (session, menu, callbacks and catch errors)
bot.use((new TelegrafSession({ database: session_filename })).middleware());

bot.use(menu.init({
  backButtonText: '⏪ Previous menu',
  mainMenuButtonText: '⏮️ Main menu'
}));

bot.use((ctx, next) => {
  if (ctx.callbackQuery) {
    logger.info(`Another callbackQuery happened ${ctx.callbackQuery.data.length} ${ctx.callbackQuery.data}`);
  }
  return next();
});

bot.catch(error => {
  logger.error(`Telegraf error ${error.response} ${error.parameters} ${error.on || error}`);
});

// main function
async function startup() {
  await bot.launch();
  logger.info(`Bot started as ${ bot.options.username }`);
}
startup();
