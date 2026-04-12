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

function sanitizeFilename(subject) {
  if (!subject) return 'no-subject';
  
  return subject
    .toLowerCase()
    .replace(/[^a-z0-9\s\-_]/g, '')
    .trim()
    .replace(/\s+/g, '-')
    .substring(0, 100);
}

function setupEmailsDirectory() {
  const emailsDir = 'emails';
  
  if (fs.existsSync(emailsDir)) {
    fs.rmSync(emailsDir, { recursive: true, force: true });
  }
  
  fs.mkdirSync(emailsDir, { recursive: true });
  
  return emailsDir;
}

function saveEmail(email, index, total, emailsDir) {
  let content = '';
  
  content += `=== Email ${index + 1}/${total} ===\n`;
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
  
  const subject = email.subject || 'no-subject';
  const safeFilename = sanitizeFilename(subject);
  const timestamp = email.date ? email.date.getTime() : Date.now();
  const filename = `${timestamp}-${safeFilename}.md`;
  const filepath = path.join(emailsDir, filename);
  
  fs.writeFileSync(filepath, content, 'utf8');
  
  return { filename, subject };
}

function fetchEmails() {
  const imap = new Imap(imapConfig);

  imap.once('ready', () => {
    imap.openBox('INBOX', false, (err, box) => {
      if (err) {
        console.error('Error opening INBOX:', err);
        imap.end();
        process.exit(1);
      }

      const fetchCount = 100;

      imap.search([['X-GM-RAW', 'category:primary']], (err, results) => {
        if (err) {
          console.error('Search error:', err);
          imap.end();
          process.exit(1);
        }

        if (results.length === 0) {
          console.log('No emails found in Primary category');
          imap.end();
          return;
        }

        const recentResults = results.slice(-fetchCount);

        const fetch = imap.fetch(recentResults, {
          bodies: '',
          struct: true
        });

        const emails = [];
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
                emails.push(parsed);
                count++;

                if (count === recentResults.length) {
                  const sortedEmails = emails.sort((a, b) => {
                    const aDate = a.date ? new Date(a.date) : new Date(0);
                    const bDate = b.date ? new Date(b.date) : new Date(0);
                    return bDate - aDate;
                  });

                  console.log('Setting up emails directory...');
                  const emailsDir = setupEmailsDirectory();
                  console.log(`📁 Emails will be saved to: ${emailsDir}/\n`);

                  let savedCount = 0;
                  const totalEmails = sortedEmails.length;
                  const progressInterval = Math.max(1, Math.floor(totalEmails / 10));

                  console.log(`🔄 Processing ${totalEmails} emails...\n`);

                  sortedEmails.forEach((email, index) => {
                    try {
                      const result = saveEmail(email, index, totalEmails, emailsDir);
                      savedCount++;
                      
                      if ((index + 1) % progressInterval === 0 || index + 1 === totalEmails) {
                        console.log(`✓ Progress: ${savedCount}/${totalEmails} emails saved`);
                        
                        if ((index + 1) % (progressInterval * 2) === 0) {
                          console.log(`  Last processed: ${result.subject.substring(0, 50)}...`);
                        }
                      }
                    } catch (error) {
                      console.error(`✗ Error saving email ${index + 1}: ${error.message}`);
                    }
                  });

                  console.log(`\n✅ Successfully saved ${savedCount}/${totalEmails} emails to ${emailsDir}/`);
                  console.log(`📊 Processing complete!`);

                  imap.end();
                }
              } catch (parseError) {
                console.error('Error parsing email:', parseError);
              }
            });
          });

          msg.once('error', (err) => {
            console.error(`Error fetching message ${seqno}:`, err);
          });
        });

        fetch.once('error', (err) => {
          console.error('Fetch error:', err);
          imap.end();
          process.exit(1);
        });

        fetch.once('end', () => {
          if (count === 0) {
            console.log('No emails fetched');
            imap.end();
          }
        });
      });
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

console.log('Fetching 100 most recent emails from Gmail Primary category...\n');
fetchEmails();
