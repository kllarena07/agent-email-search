import 'dotenv/config';
import Imap from 'node-imap';
import { simpleParser } from 'mailparser';

const imapConfig = {
  user: process.env.GMAIL_EMAIL,
  password: process.env.GMAIL_APP_PASSWORD,
  host: 'imap.gmail.com',
  port: 993,
  tls: true
};

function printEmail(email, index, total) {
  console.log(`=== Email ${index + 1}/${total} ===`);
  console.log('HEADERS:');

  if (email.from) {
    console.log(`- From: ${email.from.value.map(addr => `${addr.name || ''} <${addr.address}>`).join(', ')}`);
  }

  if (email.to) {
    console.log(`- To: ${email.to.value.map(addr => `${addr.name || ''} <${addr.address}>`).join(', ')}`);
  }

  if (email.cc) {
    console.log(`- Cc: ${email.cc.value.map(addr => `${addr.name || ''} <${addr.address}>`).join(', ')}`);
  }

  if (email.subject) {
    console.log(`- Subject: ${email.subject}`);
  }

  if (email.date) {
    console.log(`- Date: ${email.date.toISOString()}`);
  }

  if (email.messageId) {
    console.log(`- Message-ID: ${email.messageId}`);
  }

  if (email.inReplyTo) {
    console.log(`- In-Reply-To: ${email.inReplyTo}`);
  }

  if (email.references) {
    console.log(`- References: ${email.references.join(', ')}`);
  }

  console.log('');

  if (email.html) {
    console.log('BODY HTML:');
    console.log(email.html);
    console.log('');
  }

  if (email.text) {
    console.log('BODY PLAIN TEXT:');
    console.log(email.text);
    console.log('');
  }

  if (email.attachments && email.attachments.length > 0) {
    console.log('ATTACHMENTS:');
    email.attachments.forEach(att => {
      console.log(`- ${att.filename} (${att.size} bytes, ${att.contentType})`);
    });
    console.log('');
  }

  console.log('---');
  console.log('');
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

      const fetchCount = 5;
      const range = `${Math.max(1, box.messages.total - fetchCount + 1)}:${box.messages.total}`;

      const fetch = imap.fetch(range, {
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

              if (count === Math.min(fetchCount, box.messages.total)) {
                const sortedEmails = emails.sort((a, b) => {
                  const aDate = a.date ? new Date(a.date) : new Date(0);
                  const bDate = b.date ? new Date(b.date) : new Date(0);
                  return bDate - aDate;
                });

                sortedEmails.forEach((email, index) => {
                  printEmail(email, index, sortedEmails.length);
                });

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
          console.log('No emails found in INBOX');
          imap.end();
        }
      });
    });
  });

  imap.once('error', (err) => {
    console.error('IMAP connection error:', err);
    process.exit(1);
  });

  imap.once('end', () => {
    console.log('Connection ended');
  });

  imap.connect();
}

if (!process.env.GMAIL_EMAIL || !process.env.GMAIL_APP_PASSWORD) {
  console.error('Error: GMAIL_EMAIL and GMAIL_APP_PASSWORD must be set in .env file');
  console.error('Create a .env file based on .env.example');
  process.exit(1);
}

console.log('Fetching 5 most recent emails from Gmail...');
fetchEmails();
