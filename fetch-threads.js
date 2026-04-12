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
  
  if (fs.existsSync(threadsDir)) {
    fs.rmSync(threadsDir, { recursive: true, force: true });
  }
  
  fs.mkdirSync(threadsDir, { recursive: true });
  
  return threadsDir;
}

function createThreadDirectory(threadId, subject) {
  const safeSubject = sanitizeFilename(subject);
  const dirName = `${safeSubject}-${threadId}`;
  const threadPath = path.join('threads', dirName);
  
  fs.mkdirSync(threadPath, { recursive: true });
  
  return threadPath;
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
  
  const metadata = {
    threadId,
    totalMessages: messages.length,
    dateRange,
    participants,
    messageTypes
  };
  
  const metadataPath = path.join(threadPath, 'thread-metadata.json');
  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
  
  return metadata;
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

async function verifyThreadCompleteness(imap, threadId, existingEmails) {
  return new Promise((resolve, reject) => {
    imap.search([['X-GM-THRID', threadId]], async (err, results) => {
      if (err) {
        console.error(`Error searching for thread ${threadId}:`, err);
        resolve(existingEmails);
        return;
      }
      
      if (results.length === 0) {
        resolve(existingEmails);
        return;
      }
      
      const existingUids = new Set(existingEmails.map(email => email.uid));
      const missingUids = results.filter(uid => !existingUids.has(uid));
      
      if (missingUids.length === 0) {
        resolve(existingEmails);
        return;
      }
      
      console.log(`  Found ${missingUids.length} additional messages in thread ${threadId}`);
      
      try {
        const additionalMessages = await fetchWithRetry(imap, missingUids, {
          bodies: '',
          struct: true
        });
        
        const allMessages = [...existingEmails];
        
        for (const { parsed, seqno } of additionalMessages) {
          const uid = missingUids[seqno - 1];
          allMessages.push({ ...parsed, uid });
        }
        
        resolve(allMessages);
      } catch (error) {
        console.error(`Error fetching additional messages for thread ${threadId}:`, error);
        resolve(existingEmails);
      }
    });
  });
}

async function fetchThreads() {
  const imap = new Imap(imapConfig);
  
  imap.once('ready', () => {
    imap.openBox('[Gmail]/All Mail', false, async (err, box) => {
      if (err) {
        console.error('Error opening [Gmail]/All Mail:', err);
        imap.end();
        process.exit(1);
      }
      
      console.log(`Found ${box.messages.total} messages in [Gmail]/All Mail`);
      console.log('Starting fetch of all messages...\n');
      
      try {
        const allUids = [];
        for (let i = 1; i <= box.messages.total; i++) {
          allUids.push(i);
        }
        
        console.log('Phase 1: Fetching all messages from All Mail...');
        const allMessages = await fetchWithRetry(imap, allUids, {
          bodies: '',
          struct: true
        });
        
        console.log(`✓ Fetched ${allMessages.length} messages\n`);
        
        const threadGroups = new Map();
        const messageToThread = new Map();
        
        allMessages.forEach(({ parsed, seqno }) => {
          const uid = allUids[seqno - 1];
          const email = { ...parsed, uid };
          
          if (email.messageId) {
            messageToThread.set(email.messageId, email);
          }
          
          if (email.uid) {
            const threadId = email.uid['x-gm-thrid'];
            if (threadId) {
              if (!threadGroups.has(threadId)) {
                threadGroups.set(threadId, []);
              }
              threadGroups.get(threadId).push(email);
            }
          }
        });
        
        console.log(`Phase 2: Discovered ${threadGroups.size} unique threads`);
        console.log('Phase 3: Verifying thread completeness...\n');
        
        const threadsDir = setupThreadsDirectory();
        console.log(`📁 Threads will be saved to: ${threadsDir}/\n`);
        
        let threadIndex = 0;
        let totalMessagesSaved = 0;
        const progressInterval = Math.max(1, Math.floor(threadGroups.size / 10));
        
        for (const [threadId, messages] of threadGroups.entries()) {
          try {
            threadIndex++;
            
            const verifiedMessages = await verifyThreadCompleteness(imap, threadId, messages);
            
            const sortedMessages = verifiedMessages.sort((a, b) => {
              const aDate = a.date ? new Date(a.date) : new Date(0);
              const bDate = b.date ? new Date(b.date) : new Date(0);
              return aDate - bDate;
            });
            
            const subject = sortedMessages[0]?.subject || 'No Subject';
            const threadPath = createThreadDirectory(threadId, subject);
            const metadata = writeThreadMetadata(threadId, sortedMessages, threadPath);
            
            let messageIndex = 1;
            for (const message of sortedMessages) {
              try {
                await saveMessage(message, messageIndex, sortedMessages.length, metadata, threadPath);
                totalMessagesSaved++;
                messageIndex++;
              } catch (error) {
                console.error(`✗ Error saving message ${messageIndex} in thread ${threadId}: ${error.message}`);
              }
            }
            
            if (threadIndex % progressInterval === 0 || threadIndex === threadGroups.size) {
              console.log(`✓ Progress: ${threadIndex}/${threadGroups.size} threads processed`);
              console.log(`  Total messages saved: ${totalMessagesSaved}`);
              
              if (threadIndex % (progressInterval * 2) === 0) {
                console.log(`  Last thread: ${subject.substring(0, 50)}... (${sortedMessages.length} messages)`);
              }
            }
          } catch (error) {
            console.error(`✗ Error processing thread ${threadId}: ${error.message}`);
          }
        }
        
        console.log(`\n✅ Successfully processed ${threadIndex}/${threadGroups.size} threads`);
        console.log(`📊 Total messages saved: ${totalMessagesSaved}`);
        console.log(`📁 Threads saved to: ${threadsDir}/`);
        console.log(`🎉 Thread fetching complete!`);
        
        imap.end();
      } catch (error) {
        console.error('Error during thread fetching:', error);
        imap.end();
        process.exit(1);
      }
    });
  });
  
  imap.once('error', (err) => {
    console.error('IMAP connection error:', err);
    process.exit(1);
  });
  
  imap.once('end', () => {});
  
  imap.connect();
}

if (!process.env.GMAIL_EMAIL || !process.env.GMAIL_APP_PASSWORD) {
  console.error('Error: GMAIL_EMAIL and GMAIL_APP_PASSWORD must be set in .env file');
  console.error('Create a .env file based on .env.example');
  process.exit(1);
}

console.log('Starting complete email thread fetcher...');
console.log('Fetching ALL emails from [Gmail]/All Mail and organizing by thread\n');
fetchThreads();
