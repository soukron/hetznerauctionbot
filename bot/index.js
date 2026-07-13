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
      reply_timeout      = process.env.REPLY_TIMEOUT || 10,
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
const replyWithAutoDelete = (ctx, message, timeout = reply_timeout) => {
  ctx.reply(message, reply_format).then(({ message_id }) => {
    setTimeout(() => ctx.deleteMessage(message_id), timeout * 1000);
  });
}

// function to generate help message
const getHelpMessage = (isPremium) => {
  let message = '🤖 *Hetzner Auction Servers Bot*\n\n';
  message += 'This bot helps you find and get notified about servers from the [Hetzner Server Auction](https://www.hetzner.com/sb?country=ot) that match your specific criteria.\n\n';
  
  message += '*📋 HOW IT WORKS*\n';
  message += '1. Configure your search filters (Max Price, Min HD, Min RAM, CPU Type)\n';
  message += '2. Enable notifications to receive alerts when new servers match your criteria\n';
  message += '3. Use "Search now" to manually search for available servers\n';
  message += '4. Messages auto-delete after a few seconds to keep your chat clean\n\n';
  
  message += '*🆓 FREE PLAN*\n';
  message += '• *Notifications:* Up to 4 grouped messages per day\n';
  message += '  - Sent at fixed times: 00:00, 06:00, 12:00, 18:00 UTC\n';
  message += '  - Maximum 5 servers per message (sorted by price, lowest first)\n';
  message += '  - Servers are grouped together in a single message\n';
  message += '• *Searches:* Up to 5 manual searches per day\n';
  message += '• *Results:* Maximum 3 servers per search\n\n';
  
  message += '*🏅 PREMIUM PLAN*\n';
  message += '• *Notifications:* Unlimited, immediate, and individual\n';
  message += '  - Receive notifications as soon as matching servers are detected\n';
  message += '  - Each server sent in a separate message\n';
  message += '  - No daily limits\n';
  message += '• *Searches:* Unlimited manual searches per day\n';
  message += '• *Results:* Up to 10 servers per search\n\n';
  
  message += '*⚙️ CONFIGURATION OPTIONS*\n';
  message += 'Use the "🔧 Filters" menu to configure:\n';
  message += '• *Max. Price:* Maximum monthly price (excl. VAT) in €\n';
  message += '• *Min. Disks:* Minimum number of disks (1-4)\n';
  message += '• *Min. RAM:* Minimum RAM size in GB\n';
  message += '• *RAM Type:* ECC, No ECC, or Any\n';
  message += '• *CPU Type:* Intel, AMD, or Any\n';
  message += '• *Disk Type:* SSD, SATA, or Any\n\n';
  
  message += '*📱 COMMANDS*\n';
  message += '• `/start` - Show the main menu\n';
  message += '• `/help` - Show this help message\n\n';
  
  message += '*💡 TIPS*\n';
  message += '• Set specific filters to receive only relevant notifications\n';
  message += '• Premium users get instant notifications, perfect for rare configurations\n\n';
  
  if (!isPremium) {
    message += '*💎 Want Premium?*\n';
    message += 'Tap the "🏅 Enable premium features" button in the menu to learn more!\n\n';
  }
  
  message += 'Need help? Contact [@Soukron](https://t.me/soukron)';
  
  return message;
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
    'name': 'cputype',
    'title': 'CPU Type',
    'values': ['Any', 'Intel', 'AMD'],
    'menu': new TelegrafInlineMenu('Set the preferred CPU type:'),
    'joinLastRow': false
  },
  {
    'name': 'minhd',
    'title': 'Min. Disks',
    'values': ['Any', '1', '2', '3', '4'],
    'menu': new TelegrafInlineMenu('Set the min. number of disks:'),
    'joinLastRow': false
  },
  {
    'name': 'disktype',
    'title': 'Disk Type',
    'values': ['Any', 'SSD', 'SATA'],
    'menu': new TelegrafInlineMenu('Set the preferred disk type:'),
    'joinLastRow': true
  },
  {
    'name': 'minram',
    'title': 'Min. RAM',
    'values': ['Any', '2', '4', '8', '12', '16', '24', '32', '48', '64', '96', '128', '256', '512', '768'],
    'menu': new TelegrafInlineMenu('Set the min. RAM size in GB:'),
    'joinLastRow': false
  },
  {
    'name': 'ramtype',
    'title': 'RAM Type',
    'values': ['Any', 'ECC', 'No ECC'],
    'menu': new TelegrafInlineMenu('Set the preferred RAM type:'),
    'joinLastRow': true
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
    replyWithAutoDelete(ctx, message, 10);
  }
});
// settings -> submenus for each filter option
filters.forEach(item => {
  // create the filter submenu
  item.menu.select(`set-${item.name}`, item.values, {
    setFunc: (ctx, key) => {
      // Initialize filters if not defined
      if (typeof ctx.session.filters === 'undefined') {
        ctx.session.notifications = true;
        ctx.session.filters = {};
      }
      // Initialize missing filters (for backward compatibility)
      filters.forEach(filter => {
        if (!ctx.session.filters[filter.name]) {
          ctx.session.filters[filter.name] = [filter.title, filter.values[0]];
        }
      });
      // set the value in the session
      logger.debug(`${ctx.update.callback_query.from.id} (${ctx.update.callback_query.from.username}) sets ${item.name} => ${key}`);
      ctx.session.username = ctx.update.callback_query.from.username;
      ctx.session.filters[item.name] = [item.title, key];
    },
    isSetFunc: (ctx, key) => {
      try {
        // Initialize filters if not defined
        if (typeof ctx.session.filters === 'undefined') {
          ctx.session.notifications = true;
          ctx.session.filters = {};
        }
        // Initialize missing filters (for backward compatibility)
        filters.forEach(filter => {
          if (!ctx.session.filters[filter.name]) {
            ctx.session.filters[filter.name] = [filter.title, filter.values[0]];
          }
        });
        // return (true) if user is viewing this specific value
        return ctx.session.filters[item.name][1] === key;
      }
      catch (error) { 
        // Initialize filters in session if error
        if (typeof ctx.session.filters === 'undefined') {
          ctx.session.notifications = true;
          ctx.session.filters = {};
        }
        // Initialize all filters
        filters.forEach(filter => {
          ctx.session.filters[filter.name] = [filter.title, filter.values[0]];
        });
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
      replyWithAutoDelete(ctx, `You have reached the daily limit of ${max_daily_searches} searches. Please try again tomorrow or unlock Premium features.`, 10);
    } else {
      if (!isPremium) {
        ctx.session.searchCount++;
      }

      const servers = findServersForUser(ctx.update.callback_query.from.id, local_filename, session_filename);
      if (servers.length === 0) {
        replyWithAutoDelete(ctx, 'There are no active servers that match your criteria.', 10);
      } else {
        let messages = [];
        let max_slice = (isPremium? abs_max_results:max_results);

        messages.push(`Here are the most recent ${max_slice} servers (out of ${servers.length}):`);
        servers.slice(0, max_slice).forEach(server => messages.push(server));
        if (!isPremium) {
          messages.push(`You can do *${max_daily_searches - ctx.session.searchCount} more searches* today.`);
        }
        replyWithAutoDelete(ctx, messages.join('\n'), 60);
      }
    }
  },
  joinLastRow: true
});
menu.toggle(ctx => ctx.session.notifications? 'Disable notifications': 'Enable notifications', 'notifications', {
  isSetFunc: ctx => ctx.session.notifications,
  setFunc: (ctx, newState) => {
    ctx.session.notifications = newState;
    ctx.session.notifications = newState;
    logger.debug(`${ctx.update.callback_query.from.id} (${ctx.update.callback_query.from.username}) sets notifications => ${newState}`);
  }
});
menu.simpleButton('ℹ️ Help', 'help', {
  doFunc: ctx => {
    const isPremium = ctx.session.premium === 1;
    const message = getHelpMessage(isPremium);
    replyWithAutoDelete(ctx, message, 30);
  }
});
menu.simpleButton(ctx => ctx.session.premium && ctx.session.premium === 1? '🏅 Premium features enabled':'🏅  Enable premium features', 'premium', {
  doFunc: ctx => {
    let nonPremiumMessage = '💎 *Premium Plan Benefits*\n\n';
    nonPremiumMessage += 'Consider supporting the developer and get:\n\n';
    nonPremiumMessage += '*📬 Notifications:*\n';
    nonPremiumMessage += '• Unlimited, immediate, and individual\n';
    nonPremiumMessage += '• Receive notifications as soon as matching servers are detected\n';
    nonPremiumMessage += '• Each server sent in a separate message\n';
    nonPremiumMessage += '• No daily limits\n\n';
    nonPremiumMessage += '*🔍 Searches:*\n';
    nonPremiumMessage += '• Unlimited manual searches per day\n\n';
    nonPremiumMessage += '*📊 Results:*\n';
    nonPremiumMessage += '• Up to 10 servers per search\n\n';
    nonPremiumMessage += 'Tap the button in the menu to enable Premium features!';

    let premiumMessage = '🏅 *Premium Features Active*\n\n';
    premiumMessage += 'Thanks for supporting the developer! As a *premium member* you enjoy:\n\n';
    premiumMessage += '*📬 Notifications:*\n';
    premiumMessage += '• Unlimited, immediate, and individual\n';
    premiumMessage += '• Receive notifications as soon as matching servers are detected\n';
    premiumMessage += '• Each server sent in a separate message\n';
    premiumMessage += '• No daily limits\n\n';
    premiumMessage += '*🔍 Searches:*\n';
    premiumMessage += '• Unlimited manual searches per day\n\n';
    premiumMessage += '*📊 Results:*\n';
    premiumMessage += '• Up to 10 servers per search\n\n';
    premiumMessage += 'Thank you for your support! 🙏';

    if (ctx.session.premium === 1) {
      replyWithAutoDelete(ctx, premiumMessage, 10);
    }
    else {
      replyWithAutoDelete(ctx, nonPremiumMessage, 10);
    }  
  }
});

// set bot options (session, menu, callbacks and catch errors)
bot.use((new TelegrafSession({ database: session_filename })).middleware());

// /start command handler - delete user's message before showing menu
// This must be registered BEFORE menu.init() so it executes first
bot.command('start', async (ctx, next) => {
  // Delete the user's command message
  if (ctx.message) {
    ctx.deleteMessage(ctx.message.message_id).catch(err => {
      // Ignore errors if message is too old or already deleted
      logger.debug(`Could not delete start command message: ${err.message}`);
    });
  }
  
  // Wrap ctx.reply and ctx.telegram.sendMessage to intercept the menu message
  const originalReply = ctx.reply.bind(ctx);
  const originalSendMessage = ctx.telegram.sendMessage.bind(ctx.telegram);
  
  const scheduleMenuDeletion = (sentMessage) => {
    if (sentMessage && sentMessage.message_id) {
      const messageId = sentMessage.message_id;
      const chatId = ctx.chat.id;
      
      // Schedule deletion after 5 minutes (300 seconds)
      setTimeout(() => {
        ctx.telegram.deleteMessage(chatId, messageId).catch(err => {
          // Ignore errors if message is too old or already deleted
          logger.debug(`Could not delete menu message: ${err.message}`);
        });
      }, 5 * 60 * 1000); // 5 minutes
    }
  };
  
  ctx.reply = function(...args) {
    const result = originalReply(...args);
    
    // Check if this is the main menu message
    if (args[0] && typeof args[0] === 'string' && args[0].includes('Choose an option:')) {
      result.then(scheduleMenuDeletion).catch(err => {
        logger.debug(`Error handling menu message: ${err.message}`);
      });
    }
    
    return result;
  };
  
  ctx.telegram.sendMessage = function(...args) {
    const result = originalSendMessage(...args);
    
    // Check if this is the main menu message (text is in args[1] for sendMessage)
    if (args[1] && typeof args[1] === 'string' && args[1].includes('Choose an option:')) {
      result.then(scheduleMenuDeletion).catch(err => {
        logger.debug(`Error handling menu message: ${err.message}`);
      });
    }
    
    return result;
  };
  
  // Continue with menu processing
  await next();
  
  // Keep wrapper active for a short time after menu processing
  // to ensure menu message is captured
  setTimeout(() => {
    // Restore original methods after a delay
    ctx.reply = originalReply;
    ctx.telegram.sendMessage = originalSendMessage;
  }, 2000); // 2 seconds should be enough for menu to be sent
});

bot.use(menu.init({
  backButtonText: '⏪ Previous menu',
  mainMenuButtonText: '⏮️ Main menu'
}));

// /help command handler
bot.command('help', (ctx) => {
  // Delete the user's command message
  if (ctx.message) {
    ctx.deleteMessage(ctx.message.message_id).catch(err => {
      // Ignore errors if message is too old or already deleted
      logger.debug(`Could not delete help command message: ${err.message}`);
    });
  }
  const isPremium = ctx.session.premium === 1;
  const message = getHelpMessage(isPremium);
  replyWithAutoDelete(ctx, message, 60);
});

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
