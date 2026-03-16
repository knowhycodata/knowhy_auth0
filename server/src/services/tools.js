/**
 * LLM Function Calling Tool Tanımları
 * 
 * BLIND TOKEN INJECTION: LLM sadece tool adı ve parametreleri gönderir.
 * Token'lar backend'de kalır, LLM hiçbir zaman token görmez.
 * LLM'e sadece işlem sonucu döner (success: true/false).
 */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'read_emails',
      description: 'Read the user\'s recent emails from Gmail inbox. Returns email subjects, senders, dates and snippets.',
      parameters: {
        type: 'object',
        properties: {
          maxResults: {
            type: 'number',
            description: 'Maximum number of emails to fetch (1-20)',
            default: 10,
          },
          query: {
            type: 'string',
            description: 'Search query to filter emails (e.g., "from:john@example.com", "is:unread", "subject:meeting")',
          },
          labelIds: {
            type: 'array',
            items: { type: 'string' },
            description: 'Label IDs to filter by (e.g., ["INBOX"], ["SENT"], ["UNREAD"])',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_email_detail',
      description: 'Read the full content/body of a specific email by its message ID.',
      parameters: {
        type: 'object',
        properties: {
          messageId: {
            type: 'string',
            description: 'The Gmail message ID to read',
          },
        },
        required: ['messageId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'send_email',
      description: 'Send a new email or reply to an existing thread. This is a HIGH-STAKES action that requires user MFA approval.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'Recipient email address',
          },
          subject: {
            type: 'string',
            description: 'Email subject line',
          },
          body: {
            type: 'string',
            description: 'Email body text',
          },
          cc: {
            type: 'string',
            description: 'CC recipients (comma-separated)',
          },
          inReplyTo: {
            type: 'string',
            description: 'Message ID to reply to',
          },
          threadId: {
            type: 'string',
            description: 'Thread ID for replies',
          },
        },
        required: ['to', 'subject', 'body'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_email',
      description: 'Move an email to trash. This is a HIGH-STAKES action that requires user MFA approval.',
      parameters: {
        type: 'object',
        properties: {
          emailId: {
            type: 'string',
            description: 'The Gmail message ID to delete',
          },
        },
        required: ['emailId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'summarize_emails',
      description: 'Summarize the user\'s recent emails to give a quick overview of their inbox.',
      parameters: {
        type: 'object',
        properties: {
          maxResults: {
            type: 'number',
            description: 'Number of emails to include in summary (1-20)',
            default: 10,
          },
          query: {
            type: 'string',
            description: 'Search query to filter which emails to summarize',
          },
        },
        required: [],
      },
    },
  },
];

// High-stakes actions that require Step-up Auth (MFA)
const HIGH_STAKES_TOOLS = ['send_email', 'delete_email'];

function isHighStakesAction(toolName) {
  return HIGH_STAKES_TOOLS.includes(toolName);
}

module.exports = { TOOLS, HIGH_STAKES_TOOLS, isHighStakesAction };
