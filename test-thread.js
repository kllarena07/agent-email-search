import 'dotenv/config';
import Imap from 'node-imap';
import { simpleParser } from 'mailparser';
import TurndownService from 'turndown';

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

async function fetchSingleMessage(imap, uid) {
  return new Promise((resolve, reject) => {
    const fetch = imap.fetch(uid, {
      bodies: '',
      struct: true
    });

    let buffer = '';
    let attributes = null;

    fetch.on('message', (msg, seqno) => {
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
            resolve({ parsed, attributes, uid });
          } catch (parseError) {
            reject(new Error(`Error parsing message: ${parseError.message}`));
          }
        });
      });

      msg.once('error', (err) => {
        reject(new Error(`Error fetching message: ${err.message}`));
      });
    });

    fetch.once('error', (err) => {
      reject(err);
    });
  });
}

async function fetchThreadMessages(imap, threadId) {
  return new Promise((resolve, reject) => {
    imap.search([['X-GM-THRID', threadId]], (err, uids) => {
      if (err) {
        reject(err);
        return;
      }

      if (uids.length === 0) {
        resolve([]);
        return;
      }

      const fetch = imap.fetch(uids, {
        bodies: '',
        struct: true
      });

      const results = [];
      let count = 0;

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
              results.push({ parsed, attributes, uid: attributes?.uid });
              count++;

              if (count === uids.length) {
                resolve(results);
              }
            } catch (parseError) {
              console.error('Error parsing message:', parseError.message);
              count++;

              if (count === uids.length) {
                resolve(results);
              }
            }
          });
        });

        msg.once('error', (err) => {
          console.error(`Error fetching message: ${err.message}`);
          count++;

          if (count === uids.length) {
            resolve(results);
          }
        });
      });

      fetch.once('error', (err) => {
        reject(err);
      });
    });
  });
}

function formatMessageDisplay(email, index, total) {
  let output = '';

  const position = index === 0 ? '(Oldest)' : index === total - 1 ? '(Newest)' : '';
  output += `\n${'='.repeat(60)}\n`;
  output += `=== Message ${index + 1}/${total} ${position} ===\n`;
  output += `${'='.repeat(60)}\n\n`;

  output += 'HEADERS:\n';

  if (email.from) {
    output += `- From: ${email.from.value.map(addr => `${addr.name || ''} <${addr.address}>`).join(', ')}\n`;
  }

  if (email.to) {
    output += `- To: ${email.to.value.map(addr => `${addr.name || ''} <${addr.address}>`).join(', ')}\n`;
  }

  if (email.cc) {
    output += `- Cc: ${email.cc.value.map(addr => `${addr.name || ''} <${addr.address}>`).join(', ')}\n`;
  }

  if (email.subject) {
    output += `- Subject: ${email.subject}\n`;
  }

  if (email.date) {
    output += `- Date: ${email.date.toISOString()}\n`;
  }

  if (email.messageId) {
    output += `- Message-ID: ${email.messageId}\n`;
  }

  if (email.inReplyTo) {
    output += `- In-Reply-To: ${email.inReplyTo}\n`;
  }

  if (email.references) {
    const refs = Array.isArray(email.references)
      ? email.references.join(', ')
      : String(email.references);
    output += `- References: ${refs}\n`;
  }

  output += '\n';

  output += 'BODY:\n';

  if (email.html) {
    output += turndownService.turndown(email.html);
  } else if (email.text) {
    output += email.text;
  } else {
    output += 'No body content available';
  }

  output += '\n';

  if (email.attachments && email.attachments.length > 0) {
    output += '\nATTACHMENTS:\n';
    email.attachments.forEach(att => {
      output += `- ${att.filename} (${att.size} bytes, ${att.contentType})\n`;
    });
  }

  return output;
}

async function displayThread(threadMessages) {
  const sortedMessages = threadMessages.sort((a, b) => {
    const aDate = a.parsed.date ? new Date(a.parsed.date) : new Date(0);
    const bDate = b.parsed.date ? new Date(b.parsed.date) : new Date(0);
    return aDate - bDate;
  });

  console.log(`\n📧 Found ${sortedMessages.length} messages in thread\n`);
  console.log(`${'='.repeat(60)}\n`);

  sortedMessages.forEach((msg, index) => {
    const display = formatMessageDisplay(msg.parsed, index, sortedMessages.length);
    console.log(display);
    console.log(`${'-'.repeat(60)}\n`);
  });
}

async function testThreadFetching() {
  const imap = new Imap(imapConfig);

  await new Promise((resolve, reject) => {
    imap.once('ready', async () => {
      try {
        console.log('🔍 Testing thread fetching...\n');

        imap.openBox('[Gmail]/All Mail', false, (err, box) => {
          if (err) {
            reject(new Error(`Error opening INBOX: ${err.message}`));
            return;
          }

          imap.search([['X-GM-RAW', 'in:inbox category:primary']], (err, results) => {
            if (err) {
              reject(new Error(`Search error: ${err.message}`));
              return;
            }

            if (results.length === 0) {
              reject(new Error('No emails found in Primary category'));
              return;
            }

            const mostRecentUid = results[results.length - 1];
            console.log(`✓ Found ${results.length} emails in Primary inbox`);
            console.log(`✓ Most recent email UID: ${mostRecentUid}\n`);

            fetchSingleMessage(imap, mostRecentUid)
              .then(({ parsed, attributes }) => {
                const threadId = attributes?.xgm?.thrid || attributes?.['x-gm-thrid'];

                if (!threadId) {
                  reject(new Error('No thread ID found for most recent email'));
                  return;
                }

                console.log(`✓ Thread ID: ${threadId}\n`);

                return fetchThreadMessages(imap, threadId)
                  .then(async (threadMessages) => {
                    if (threadMessages.length === 0) {
                      console.log('⚠️  No messages found in thread');
                      imap.end();
                      resolve();
                      return;
                    }

                    await displayThread(threadMessages);
                    console.log(`${'='.repeat(60)}\n`);
                    console.log('✅ Thread test complete!\n');
                    imap.end();
                    resolve();
                  });
              })
              .catch(error => {
                reject(error);
              });
          });
        });
      } catch (error) {
        console.error('Error during test:', error);
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

testThreadFetching().catch(error => {
  console.error('❌ Test failed:', error.message);
  process.exit(1);
});