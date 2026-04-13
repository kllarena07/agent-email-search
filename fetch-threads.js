import 'dotenv/config';
import Imap from 'node-imap';
import { simpleParser } from 'mailparser';
import TurndownService from 'turndown';
import fs from 'fs';
import path from 'path';

const imapConfig = {
  user: process.env.GMAIL_EMAIL,
  password: process.env.GMAIL_APP_PASSWORD,
  host: 'imap.gmail.com',
  port: 993,
  tls: true
};

const turndownService = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
  linkStyle: 'inlined'
});

const MAX_RETRIES = 3;
const RETRY_DELAY = 1000;
const BATCH_SIZE = 500;
const BATCH_DELAY = 250;
const DAILY_LIMIT = 2400 * 1024 * 1024;
const OVERHEAD_BUFFER = 1.2;

const STATE_FILE = 'threads/.fetch-state.json';

function sanitizeFilename(filename) {
  if (!filename) return 'no-name';
  
  return filename
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .substring(0, 100);
}

function setupThreadsDirectory() {
  const threadsDir = 'threads';
  
  if (!fs.existsSync(threadsDir)) {
    fs.mkdirSync(threadsDir, { recursive: true });
  }
  
  return threadsDir;
}

function getFilePath(threadId, messageUid, subject) {
  const safeSubject = sanitizeFilename(subject);
  const filename = `${safeSubject}-${threadId}-${messageUid}.md`;
  return path.join('threads', filename);
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading state:', error.message);
  }
  
  return {
    lastDate: null,
    downloadedBytesToday: 0,
    lastProcessedUid: null
  };
}

function saveState(state) {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
  } catch (error) {
    console.error('Error saving state:', error.message);
  }
}

function checkDailyReset(state) {
  const today = new Date().toISOString().split('T')[0];
  
  if (state.lastDate !== today) {
    console.log(`New day detected. Resetting daily download counter.`);
    state.lastDate = today;
    state.downloadedBytesToday = 0;
    saveState(state);
  }
  
  return state;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function saveMessage(email, messageUid, threadId) {
  let content = '';
  
  content += `=== Message ${messageUid} ===\n`;
  content += `Thread ID: ${threadId}\n`;
  content += '\n';
  
  content += 'HEADERS:\n';
  
  if (email.from) {
    content += `- From: ${email.from.value.map(addr => `${addr.name || ''} <${addr.address}>`).join(', ')}\n`;
  }
  
  if (email.to) {
    content += `- To: ${email.to.value.map(addr => `${addr.name || ''} <${addr.address}>`).join(', ')}\n`;
  }
  
  if (email.cc) {
    content += `- Cc: ${email.cc.value.map(addr => `${addr.name || ''} <${addr.address}>`).join(', ')}\n`;
  }
  
  if (email.subject) {
    content += `- Subject: ${email.subject}\n`;
  }
  
  if (email.date) {
    content += `- Date: ${email.date.toISOString()}\n`;
  }
  
  if (email.messageId) {
    content += `- Message-ID: ${email.messageId}\n`;
  }
  
  if (email.inReplyTo) {
    content += `- In-Reply-To: ${email.inReplyTo}\n`;
  }
  
  if (email.references) {
    const refs = Array.isArray(email.references)
      ? email.references.join(', ')
      : String(email.references);
    content += `- References: ${refs}\n`;
  }
  
  content += '\n';
  
  content += 'BODY (MARKDOWN):\n';
  
  if (email.html) {
    content += turndownService.turndown(email.html);
  } else if (email.text) {
    content += email.text;
  } else {
    content += 'No body content available';
  }
  
  content += '\n\n';
  
  if (email.attachments && email.attachments.length > 0) {
    content += 'ATTACHMENTS:\n';
    email.attachments.forEach(att => {
      content += `- ${att.filename} (${att.size} bytes, ${att.contentType})\n`;
    });
    content += '\n';
  }
  
  content += '---\n\n';
  
  const filepath = getFilePath(threadId, messageUid, email.subject);
  
  fs.writeFileSync(filepath, content, 'utf8');
  
  return filepath;
}

function messageExists(messageUid, threadId, subject) {
  const filepath = getFilePath(threadId, messageUid, subject);
  return fs.existsSync(filepath);
}

function calculateMessageSize(buffer) {
  return Math.round(buffer.length * OVERHEAD_BUFFER);
}

function formatBytes(bytes) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = bytes;
  let unitIndex = 0;
  
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

async function fetchBatch(imap, uids) {
  return new Promise((resolve, reject) => {
    const fetch = imap.fetch(uids, {
      bodies: '',
      struct: true
    });

    const results = [];
    let count = 0;
    const total = uids.length;

    fetch.on('message', (msg, seqno) => {
      let buffer = '';
      let attributes = null;
      let currentUid = null;

      msg.on('attributes', (attrs) => {
        attributes = attrs;
        currentUid = attrs?.uid;
      });

      msg.on('body', (stream, info) => {
        stream.on('data', (chunk) => {
          buffer += chunk.toString('utf8');
        });

        stream.once('end', async () => {
          try {
            const parsed = await simpleParser(buffer);
            results.push({ parsed, attributes, uid: currentUid, buffer });
            count++;

            if (count === total) {
              resolve(results);
            }
          } catch (parseError) {
            console.error(`Error parsing message ${currentUid}:`, parseError.message);
            count++;

            if (count === total) {
              resolve(results);
            }
          }
        });
      });

      msg.once('error', (err) => {
        console.error(`Error fetching message ${currentUid}:`, err.message);
        count++;

        if (count === total) {
          resolve(results);
        }
      });
    });

    fetch.once('error', (err) => {
      reject(err);
    });
  });
}

async function processBatch(imap, uids, state) {
  console.log(`  Processing batch of ${uids.length} emails...`);
  
  const results = await fetchBatch(imap, uids);
  
  let savedCount = 0;
  let skippedCount = 0;
  let batchBytes = 0;

  for (const { parsed, attributes, uid, buffer } of results) {
    if (!uid) continue;
    
    const threadId = attributes?.xgm?.thrid || attributes?.['x-gm-thrid'];
    if (!threadId) {
      console.log(`    No thread ID for UID ${uid}, skipping`);
      skippedCount++;
      continue;
    }
    
    if (messageExists(uid, threadId, parsed.subject)) {
      console.log(`    Already exists: ${path.basename(getFilePath(threadId, uid, parsed.subject))}`);
      skippedCount++;
      continue;
    }
    
    await saveMessage(parsed, uid, threadId);
    
    const messageSize = calculateMessageSize(buffer);
    batchBytes += messageSize;
    savedCount++;
    
    console.log(`    Saved: ${path.basename(getFilePath(threadId, uid, parsed.subject))} (${formatBytes(messageSize)})`);
  }
  
  return { savedCount, skippedCount, batchBytes };
}

async function fetchWithRetry(imap, uids, state, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await processBatch(imap, uids, state);
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      
      console.log(`  Retry ${attempt}/${retries} after error: ${error.message}`);
      await delay(RETRY_DELAY * attempt);
    }
  }
}

function filterExistingUids(uids) {
  const uidMap = new Map();
  
  const threadsDir = 'threads';
  if (fs.existsSync(threadsDir)) {
    const files = fs.readdirSync(threadsDir);
    for (const file of files) {
      const match = file.match(/-(\d+)-(\d+)\.md$/);
      if (match) {
        const uid = parseInt(match[2]);
        uidMap.set(uid, true);
      }
    }
  }
  
  return uids.filter(uid => !uidMap.has(uid));
}

async function checkDailyLimit(state) {
  const percentage = ((state.downloadedBytesToday / DAILY_LIMIT) * 100).toFixed(1);
  console.log(`\nBandwidth: ${formatBytes(state.downloadedBytesToday)} / ${formatBytes(DAILY_LIMIT)} (${percentage}%)`);
  
  if (state.downloadedBytesToday >= DAILY_LIMIT) {
    console.log(`\n⚠️  Daily limit reached! Stopping at ${formatBytes(DAILY_LIMIT)}`);
    console.log(`Resume tomorrow to continue downloading remaining emails.\n`);
    return false;
  }
  
  return true;
}

async function fetchBatches(imap) {
  const box = await new Promise((resolve, reject) => {
    imap.openBox('[Gmail]/All Mail', false, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
  
  let state = loadState();
  state = checkDailyReset(state);

  const allUids = await new Promise((resolve, reject) => {
    imap.search([['X-GM-RAW', '-in:spam -in:trash']], (err, uids) => {
      if (err) reject(err);
      else resolve(uids);
    });
  });

  const existingUidsCount = allUids.length - filterExistingUids(allUids).length;
  const uidsToProcess = filterExistingUids(allUids);

  console.log(`Found ${allUids.length} total emails`);
  console.log(`Already downloaded: ${existingUidsCount}`);
  console.log(`Remaining to download: ${uidsToProcess.length}\n`);

  if (uidsToProcess.length === 0) {
    console.log('✅ All emails already downloaded!');
    return;
  }

  const batches = [];
  for (let i = 0; i < uidsToProcess.length; i += BATCH_SIZE) {
    batches.push(uidsToProcess.slice(i, i + BATCH_SIZE));
  }

  console.log(`Processing ${batches.length} batches (${BATCH_SIZE} emails per batch)\n`);

  let totalSaved = 0;
  let totalSkipped = 0;

  for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
    const batch = batches[batchIndex];
    const batchNum = batchIndex + 1;

    console.log(`${'='.repeat(60)}`);
    console.log(`Batch ${batchNum}/${batches.length}`);
    console.log(`${'='.repeat(60)}`);

    try {
      const result = await fetchWithRetry(imap, batch, state);

      totalSaved += result.savedCount;
      totalSkipped += result.skippedCount;
      state.downloadedBytesToday += result.batchBytes;
      state.lastProcessedUid = batch[batch.length - 1];
      saveState(state);

      console.log(`  Saved: ${result.savedCount}, Skipped: ${result.skippedCount}`);
      console.log(`  Batch bytes: ${formatBytes(result.batchBytes)}`);
      console.log(`  Total saved: ${totalSaved}\n`);

      await delay(BATCH_DELAY);

      if (batchNum < batches.length) {
        const canContinue = await checkDailyLimit(state);
        if (!canContinue) {
          console.log(`\n📊 Session complete:`);
          console.log(`   Emails saved: ${totalSaved}`);
          console.log(`   Emails skipped: ${totalSkipped}`);
          console.log(`   Bytes downloaded: ${formatBytes(state.downloadedBytesToday)}`);
          console.log(`   Progress: ${batchNum}/${batches.length} batches\n`);
          return;
        }
      }

    } catch (error) {
      console.error(`Error processing batch ${batchNum}:`, error.message);
      throw error;
    }
  }

  console.log(`${'='.repeat(60)}`);
  console.log(`\n✅ All emails processed successfully!`);
  console.log(`📊 Total emails saved: ${totalSaved}`);
  console.log(`📊 Total emails skipped: ${totalSkipped}`);
  console.log(`📊 Total bytes downloaded: ${formatBytes(state.downloadedBytesToday)}`);
  console.log(`🎉 Email fetching complete!\n`);
}

async function fetchThreads() {
  const imap = new Imap(imapConfig);
  
  setupThreadsDirectory();
  
  await new Promise((resolve, reject) => {
    imap.once('ready', async () => {
      try {
        await fetchBatches(imap);
        imap.end();
        resolve();
      } catch (error) {
        console.error('Error during email fetching:', error);
        imap.end();
        reject(error);
      }
    });
    
    imap.once('error', (err) => {
      console.error('IMAP connection error:', err);
      process.exit(1);
    });
    
    imap.once('end', () => {});
    
    imap.connect();
  });
}

if (!process.env.GMAIL_EMAIL || !process.env.GMAIL_APP_PASSWORD) {
  console.error('Error: GMAIL_EMAIL and GMAIL_APP_PASSWORD must be set in .env file');
  console.error('Create a .env file based on .env.example');
  process.exit(1);
}

console.log('Starting email fetcher with batch processing...');
console.log(`Batch size: ${BATCH_SIZE} emails`);
console.log(`Daily limit: ${formatBytes(DAILY_LIMIT)}`);
console.log(`Fetching emails from [Gmail]/All Mail (excluding spam/trash)\n`);
fetchThreads();