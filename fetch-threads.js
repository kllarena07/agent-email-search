import 'dotenv/config';
import Imap from 'node-imap';
import { simpleParser } from 'mailparser';
import TurndownService from 'turndown';
import fs from 'fs';
import path from 'path';

const BATCH_SIZE = 100;
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

function getThreadPath(threadId, subject) {
  const safeSubject = sanitizeFilename(subject);
  const dirName = `${safeSubject}-${threadId}`;
  return path.join('threads', dirName);
}

function extractParticipants(messages) {
  const participants = new Set();
  
  messages.forEach(email => {
    if (email.from && email.from.value) {
      email.from.value.forEach(addr => {
        if (addr.address) participants.add(addr.address);
      });
    }
    
    if (email.to && email.to.value) {
      email.to.value.forEach(addr => {
        if (addr.address) participants.add(addr.address);
      });
    }
    
    if (email.cc && email.cc.value) {
      email.cc.value.forEach(addr => {
        if (addr.address) participants.add(addr.address);
      });
    }
  });
  
  return Array.from(participants).sort();
}

function getMessageTypes(messages) {
  const userEmail = process.env.GMAIL_EMAIL.toLowerCase();
  let sent = 0;
  let received = 0;
  
  messages.forEach(email => {
    if (email.from && email.from.value && email.from.value[0]) {
      const fromEmail = email.from.value[0].address.toLowerCase();
      if (fromEmail === userEmail) {
        sent++;
      } else {
        received++;
      }
    } else {
      received++;
    }
  });
  
  return { sent, received };
}

function getDateRange(messages) {
  const dates = messages
    .map(email => email.date ? new Date(email.date) : null)
    .filter(date => date !== null)
    .sort((a, b) => a - b);
  
  if (dates.length === 0) return { start: null, end: null };
  
  return {
    start: dates[0].toISOString(),
    end: dates[dates.length - 1].toISOString()
  };
}

function writeThreadMetadata(threadId, messages, threadPath) {
  const participants = extractParticipants(messages);
  const messageTypes = getMessageTypes(messages);
  const dateRange = getDateRange(messages);
  const subject = messages[0]?.subject || 'No Subject';
  
  const metadata = {
    threadId,
    subject,
    totalMessages: messages.length,
    dateRange,
    participants,
    messageTypes
  };
  
  const metadataPath = path.join(threadPath, 'thread-metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  
  return metadata;
}

function updateThreadMetadata(existingMetadata, newMessages) {
  const allMessages = [...existingMetadata.allMessages, ...newMessages];
  const participants = extractParticipants(allMessages);
  const messageTypes = getMessageTypes(allMessages);
  const dateRange = getDateRange(allMessages);
  
  return {
    threadId: existingMetadata.threadId,
    subject: existingMetadata.subject,
    totalMessages: allMessages.length,
    dateRange,
    participants,
    messageTypes
  };
}

async function saveMessage(email, messageIndex, totalMessages, metadata, threadPath) {
  let content = '';
  
  content += `=== Thread: ${metadata.subject || 'No Subject'} ===\n`;
  content += `Thread ID: ${metadata.threadId}\n`;
  content += `Total Messages: ${metadata.totalMessages}\n`;
  
  if (metadata.dateRange.start && metadata.dateRange.end) {
    content += `Date Range: ${metadata.dateRange.start.split('T')[0]} to ${metadata.dateRange.end.split('T')[0]}\n`;
  }
  
  content += `Participants: ${metadata.participants.join(', ')}\n`;
  content += `Message Types: ${metadata.messageTypes.received} received, ${metadata.messageTypes.sent} sent\n`;
  content += '\n';
  
  content += `--- Message ${messageIndex}/${totalMessages} ---\n`;
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
  
  const filename = `message-${messageIndex}.md`;
  const filepath = path.join(threadPath, filename);
  
  fs.writeFileSync(filepath, content, 'utf8');
  
  return filename;
}

async function fetchWithRetry(imap, uids, options, retries = MAX_RETRIES) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        const fetch = imap.fetch(uids, options);
        const results = [];
        let count = 0;
        
        fetch.on('message', (msg, seqno) => {
          let buffer = '';
          
          msg.on('body', (stream, info) => {
            stream.on('data', (chunk) => {
              buffer += chunk.toString('utf8');
            });
            
            stream.once('end', async () => {
              try {
                const parsed = await simpleParser(buffer);
                results.push({ parsed, seqno });
                count++;
                
                if (count === uids.length) {
                  resolve(results);
                }
              } catch (parseError) {
                console.error(`Error parsing message ${seqno}:`, parseError.message);
                count++;
                
                if (count === uids.length) {
                  resolve(results);
                }
              }
            });
          });
          
          msg.once('error', (err) => {
            console.error(`Error fetching message ${seqno}:`, err.message);
            count++;
            
            if (count === uids.length) {
              resolve(results);
            }
          });
        });
        
        fetch.once('error', (err) => {
          reject(err);
        });
        
        fetch.once('end', () => {
          if (count === 0) {
            resolve(results);
          }
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

function validateThreadDirectory(threadPath) {
  try {
    const requiredFiles = ['thread-metadata.json'];
    const files = fs.readdirSync(threadPath);
    
    for (const file of requiredFiles) {
      if (!files.includes(file)) {
        console.error(`  ✗ Missing required file: ${file}`);
        return false;
      }
    }
    
    try {
      const metadataPath = path.join(threadPath, 'thread-metadata.json');
      JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
    } catch {
      console.error(`  ✗ Invalid thread metadata`);
      return false;
    }
    
    return true;
  } catch (error) {
    console.error(`  ✗ Validation error: ${error.message}`);
    return false;
  }
}

function getNextMessageNumber(threadPath) {
  const files = fs.readdirSync(threadPath)
    .filter(f => f.startsWith('message-') && f.endsWith('.md'))
    .map(f => parseInt(f.replace('message-', '').replace('.md', '')))
    .filter(n => !isNaN(n));
  
  return files.length > 0 ? Math.max(...files) + 1 : 1;
}

function writeNewThread(threadId, messages) {
  const threadPath = getThreadPath(threadId, messages[0]?.subject);
  
  fs.mkdirSync(threadPath, { recursive: true });
  
  const metadata = writeThreadMetadata(threadId, messages, threadPath);
  
  messages.forEach((email, index) => {
    saveMessage(email, index + 1, messages.length, metadata, threadPath);
  });
  
  return threadPath;
}

function updateExistingThread(threadId, newMessages) {
  const threadPath = getThreadPath(threadId, newMessages[0]?.subject);
  
  if (!validateThreadDirectory(threadPath)) {
    console.error(`  ✗ Skipping corrupt thread ${threadId}`);
    return { success: false };
  }
  
  const nextMessageNumber = getNextMessageNumber(threadPath);
  const metadataPath = path.join(threadPath, 'thread-metadata.json');
  const existingMetadata = JSON.parse(fs.readFileSync(metadataPath, 'utf8'));
  
  const sortedNewMessages = newMessages.sort((a, b) => {
    const aDate = a.date ? new Date(a.date) : new Date(0);
    const bDate = b.date ? new Date(b.date) : new Date(0);
    return aDate - bDate;
  });
  
  const updatedMetadata = updateThreadMetadata(existingMetadata, sortedNewMessages);
  fs.writeFileSync(metadataPath, JSON.stringify(updatedMetadata, null, 2));
  
  sortedNewMessages.forEach((email, index) => {
    saveMessage(email, nextMessageNumber + index, updatedMetadata.totalMessages, updatedMetadata, threadPath);
  });
  
  return { success: true, threadPath };
}

async function processBatch(imap, batchUids) {
  const messages = await fetchWithRetry(imap, batchUids, {
    bodies: '',
    struct: true
  });
  
  const threadGroups = new Map();
  
  for (const { parsed, seqno } of messages) {
    const uid = batchUids[seqno - 1];
    const email = { ...parsed, uid };
    
    const threadId = email.uid['x-gm-thrid'];
    if (!threadId) continue;
    
    if (!threadGroups.has(threadId)) {
      threadGroups.set(threadId, []);
    }
    threadGroups.get(threadId).push(email);
  }
  
  const newThreads = [];
  const updatedThreads = [];
  let messagesSaved = 0;
  
  for (const [threadId, batchMessages] of threadGroups.entries()) {
    const threadPath = getThreadPath(threadId, batchMessages[0]?.subject);
    
    if (fs.existsSync(threadPath)) {
      const result = updateExistingThread(threadId, batchMessages);
      if (result.success) {
        updatedThreads.push(threadId);
      }
    } else {
      writeNewThread(threadId, batchMessages);
      newThreads.push(threadId);
    }
    
    messagesSaved += batchMessages.length;
  }
  
  return { newThreads, updatedThreads, messagesSaved };
}

function createInitialCheckpoint() {
  return {
    lastBatchEnd: 0,
    uidRanges: [],
    updatedThreads: [],
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

async function fetchProgressive(imap, checkpoint) {
  const box = await new Promise((resolve, reject) => {
    imap.openBox('[Gmail]/All Mail', false, (err, box) => {
      if (err) reject(err);
      else resolve(box);
    });
  });
  
  const totalEmails = box.messages.total;
  let startUid = checkpoint ? checkpoint.lastBatchEnd + 1 : 1;
  let batchNumber = 0;
  
  console.log(`Found ${totalEmails} messages in [Gmail]/All Mail`);
  console.log(`Starting fetch in ${Math.ceil(totalEmails / BATCH_SIZE)} batches of ${BATCH_SIZE} emails\n`);
  
  if (checkpoint) {
    console.log(`Resuming from batch end UID: ${checkpoint.lastBatchEnd + 1}`);
    console.log(`Total messages saved so far: ${checkpoint.totalMessagesSaved}\n`);
  }
  
  while (startUid <= totalEmails) {
    batchNumber++;
    const batchStart = startUid;
    const batchEnd = Math.min(startUid + BATCH_SIZE - 1, totalEmails);
    const batchUids = [];
    
    for (let i = batchStart; i <= batchEnd; i++) {
      batchUids.push(i);
    }
    
    console.log(`=== Batch ${batchNumber} ===`);
    console.log(`Processing UIDs: ${batchStart}-${batchEnd}`);
    
    try {
      const { newThreads, updatedThreads, messagesSaved } = await processBatch(imap, batchUids);
      
      checkpoint.lastBatchEnd = batchEnd;
      checkpoint.uidRanges.push(`${batchStart}-${batchEnd}`);
      checkpoint.updatedThreads = [...new Set([...checkpoint.updatedThreads, ...newThreads, ...updatedThreads])];
      checkpoint.totalMessagesSaved += messagesSaved;
      checkpoint.lastUpdated = new Date().toISOString();
      
      saveCheckpoint(checkpoint);
      
      const percentage = Math.round((batchEnd / totalEmails) * 100);
      console.log(`  New threads: ${newThreads.length}`);
      console.log(`  Updated threads: ${updatedThreads.length}`);
      console.log(`  Messages saved: ${messagesSaved}`);
      console.log(`  Progress: ${batchEnd}/${totalEmails} (${percentage}%)`);
      console.log(`  Overall messages saved: ${checkpoint.totalMessagesSaved}`);
      
      if (batchNumber % 10 === 0) {
        console.log(`  Total batches completed: ${batchNumber}/${Math.ceil(totalEmails / BATCH_SIZE)}`);
      }
      
      console.log('');
      
    } catch (error) {
      console.error(`Error processing batch ${batchNumber}:`, error.message);
      console.log(`Checkpoint saved at UID ${checkpoint.lastBatchEnd}, will resume from ${checkpoint.lastBatchEnd + 1}`);
      throw error;
    }
    
    startUid = batchEnd + 1;
  }
  
  console.log(`\n✅ All batches processed successfully!`);
  console.log(`📊 Total messages saved: ${checkpoint.totalMessagesSaved}`);
  console.log(`🧵 Total unique threads: ${checkpoint.updatedThreads.length}`);
  
  fs.unlinkSync(CHECKPOINT_FILE);
  console.log(`🗑️  Checkpoint file removed`);
  console.log(`🎉 Thread fetching complete!`);
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
        console.error('Error during thread fetching:', error);
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

console.log('Starting progressive email thread fetcher...');
console.log(`Fetching ALL emails from [Gmail]/All Mail in batches of ${BATCH_SIZE}\n`);
fetchThreads();
