import 'dotenv/config';
import Imap from 'node-imap';
import { simpleParser } from 'mailparser';
import TurndownService from 'turndown';
import fs from 'fs';
import path from 'path';

const CHECKPOINT_FILE = 'threads-progress.json';

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

async function fetchWithRetry(imap, uids, options, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const fetch = imap.fetch(uids, options);
        const results = [];
        
        fetch.on('message', (msg, seqno) => {
          let buffer = '';
          let attributes = null;
          
          msg.on('attributes', (attrs) => {
            attributes = attrs;
          });
          
          msg.on('body', (stream, info) => {
            stream.on('data', (chunk) => {
              buffer += chunk.toString('utf8');
            });
            
            stream.once('end', async () => {
              try {
                const parsed = await simpleParser(buffer);
                results.push({ parsed, attributes });
                resolve(results);
              } catch (parseError) {
                console.error(`Error parsing message ${seqno}:`, parseError.message);
                resolve(results);
              }
            });
          });
          
          msg.once('error', (err) => {
            console.error(`Error fetching message ${seqno}:`, err.message);
            resolve(results);
          });
        });
        
        fetch.once('error', (err) => {
          reject(err);
        });
      });
    } catch (error) {
      if (attempt === retries) {
        throw error;
      }
      
      console.log(`Retry ${attempt}/${retries} after error: ${error.message}`);
      await new Promise(resolve => setTimeout(resolve, RETRY_DELAY * attempt));
    }
  }
}

function createInitialCheckpoint() {
  return {
    lastProcessedUid: 0,
    totalMessagesSaved: 0,
    lastUpdated: new Date().toISOString()
  };
}

function loadCheckpoint() {
  if (!fs.existsSync(CHECKPOINT_FILE)) return null;
  
  try {
    const data = fs.readFileSync(CHECKPOINT_FILE, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Checkpoint corruption detected, starting fresh: ${error.message}`);
    return null;
  }
}

function saveCheckpoint(checkpoint) {
  const tempFile = `${CHECKPOINT_FILE}.tmp`;
  const data = JSON.stringify(checkpoint, null, 2);
  
  fs.writeFileSync(tempFile, data, 'utf8');
  fs.renameSync(tempFile, CHECKPOINT_FILE);
}

async function processEmail(imap, uid) {
  const messages = await fetchWithRetry(imap, [uid], {
    bodies: '',
    struct: true
  });
  
  if (messages.length === 0) {
    console.log(`  No message found for UID ${uid}`);
    return { saved: false };
  }
  
  const { parsed, attributes } = messages[0];
  const email = { ...parsed, uid };
  
  const threadId = attributes?.xgm?.thrid || attributes?.['x-gm-thrid'];
  if (!threadId) {
    console.log(`  No thread ID for UID ${uid}, skipping`);
    return { saved: false };
  }
  
  const filepath = getFilePath(threadId, uid, email.subject);
  
  if (fs.existsSync(filepath)) {
    console.log(`  Already exists: ${path.basename(filepath)}`);
    return { saved: false };
  }
  
  await saveMessage(email, uid, threadId);
  
  return { saved: true, filepath };
}

async function fetchProgressive(imap, checkpoint) {
  const box = await new Promise((resolve, reject) => {
    imap.openBox('[Gmail]/All Mail', false, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
  
  const totalEmails = box.messages.total;
  let currentUid = checkpoint ? checkpoint.lastProcessedUid + 1 : 1;
  
  console.log(`Found ${totalEmails} messages in [Gmail]/All Mail`);
  console.log(`Starting fetch, processing each email individually\n`);
  
  if (checkpoint) {
    console.log(`Resuming from UID: ${currentUid}`);
    console.log(`Total messages saved so far: ${checkpoint.totalMessagesSaved}\n`);
  }
  
  while (currentUid <= totalEmails) {
    const percentage = Math.round((currentUid / totalEmails) * 100);
    console.log(`=== Email ${currentUid}/${totalEmails} (${percentage}%) ===`);
    
    try {
      const result = await processEmail(imap, currentUid);
      
      if (result.saved) {
        checkpoint.totalMessagesSaved++;
      }
      
      checkpoint.lastProcessedUid = currentUid;
      checkpoint.lastUpdated = new Date().toISOString();
      
      saveCheckpoint(checkpoint);
      
      if (result.saved) {
        console.log(`  Saved: ${path.basename(result.filepath)}`);
        console.log(`  Total saved: ${checkpoint.totalMessagesSaved}`);
      }
      
      console.log('');
      
    } catch (error) {
      console.error(`Error processing email ${currentUid}:`, error.message);
      console.log(`Checkpoint saved at UID ${checkpoint.lastProcessedUid}, will resume from ${checkpoint.lastProcessedUid + 1}`);
      throw error;
    }
    
    currentUid++;
  }
  
  console.log(`\n✅ All emails processed successfully!`);
  console.log(`📊 Total messages saved: ${checkpoint.totalMessagesSaved}`);
  
  fs.unlinkSync(CHECKPOINT_FILE);
  console.log(`🗑️  Checkpoint file removed`);
  console.log(`🎉 Email fetching complete!`);
}

async function fetchThreads() {
  const imap = new Imap(imapConfig);
  
  setupThreadsDirectory();
  const checkpoint = loadCheckpoint();
  
  if (!checkpoint) {
    console.log('Starting fresh - no checkpoint found\n');
  }
  
  await new Promise((resolve, reject) => {
    imap.once('ready', async () => {
      try {
        await fetchProgressive(imap, checkpoint || createInitialCheckpoint());
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

console.log('Starting email fetcher...');
console.log('Fetching ALL emails from [Gmail]/All Mail, one at a time\n');
fetchThreads();
