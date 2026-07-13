const fs = require('fs');
const humanizeDuration = require("humanize-duration");

// Function to load JSON data from a file
const loadJSONFromFile = (filename) => {
  try {
    const data = fs.readFileSync(filename);
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error loading file ${filename}: ${error.message}`);
    return null;
  }
}

// Compose a message from the server data
const composeMessage = (server) => {
  const description = Array.isArray(server.description) ? server.description.join(', ') : 'No description available';
  const timeRemaining = humanizeDuration(server.next_reduce * 1000, {
    units: ['h', 'm', 's'],
    round: true,
    delimiter: ' ',
    spacer: '',
    language: 'en'
  });
  return `📌 *ID:* ${server.key}\n` +
    `🖥️ *CPU:* ${server.cpu}\n` +
    `🧮 *RAM:* ${server.ram_size}G\n` +
    `💽 *HDD:* ${server.hdd_hr.join(', ')}\n` +
    `💵 *Price:* ${parseFloat(server.price).toFixed(2)} €/month (excl. VAT)\n` +
    `📋 *Description:* ${description}\n` +
    `⏲️ *Expires in:* ${timeRemaining}\n`
}

// Function to check if server matches user filters
const serverMatchesFilters = (server, filters) => {
  if (!filters) {
    return true; // No filters means match all
  }

  // Check disk type filter
  let diskTypeMatches = true;
  if (filters.disktype && filters.disktype[1] !== "Any") {
    const diskTypeFilter = filters.disktype[1];
    const hddHrString = server.hdd_hr ? server.hdd_hr.join(' ') : '';
    if (diskTypeFilter === 'SSD') {
      diskTypeMatches = hddHrString.toUpperCase().indexOf('SSD') > -1;
    } else if (diskTypeFilter === 'SATA') {
      // SATA disks are typically marked as "SATA" or "HDD" (but not "SSD")
      diskTypeMatches = (hddHrString.toUpperCase().indexOf('SATA') > -1 || 
                        (hddHrString.toUpperCase().indexOf('HDD') > -1 && 
                         hddHrString.toUpperCase().indexOf('SSD') === -1));
    }
  }

  // Check RAM type filter
  let ramTypeMatches = true;
  if (filters.ramtype && filters.ramtype[1] !== "Any") {
    const ramTypeFilter = filters.ramtype[1];
    // Check in ram array and description array
    const ramString = server.ram ? server.ram.join(' ') : '';
    const descriptionString = server.description ? (Array.isArray(server.description) ? server.description.join(' ') : server.description) : '';
    const combinedString = (ramString + ' ' + descriptionString).toUpperCase();

    if (ramTypeFilter === 'ECC') {
      ramTypeMatches = combinedString.indexOf('ECC') > -1;
    } else if (ramTypeFilter === 'No ECC') {
      ramTypeMatches = combinedString.indexOf('ECC') === -1;
    }
  }

  return (
    (filters.maxprice && (filters.maxprice[1] === "Any" || server.price <= filters.maxprice[1])) &&
    (filters.minhd && (filters.minhd[1] === "Any" || server.hdd_count >= filters.minhd[1])) &&
    (filters.minram && (filters.minram[1] === "Any" || server.ram_size >= filters.minram[1])) &&
    (filters.cputype && (filters.cputype[1] === "Any" || server.cpu.includes(filters.cputype[1]))) &&
    diskTypeMatches &&
    ramTypeMatches
  );
}

// Function to find servers for a specific user
const findServersForUser = (userId, localFilename, sessionFilename) => {
  const localServers = loadJSONFromFile(localFilename);
  const sessions = loadJSONFromFile(sessionFilename).sessions || [];

  const userSession = sessions.find(session => session.id === userId+":"+userId);
  if (!userSession) {
    console.error(`No session found for user ID ${userId}`);
    return [];
  }

  const matchingServers = localServers.server.filter(server => serverMatchesFilters(server, userSession.data.filters));
  const messages = matchingServers.map(server => composeMessage(server));

  return messages;
}

// Export functions
module.exports = {
  findServersForUser,
  loadJSONFromFile,
  composeMessage,
  serverMatchesFilters
};
