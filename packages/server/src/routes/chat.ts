import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { v4 as uuidv4 } from 'uuid';
import { getDb } from '../db/index.js';
import { autoChat } from '../providers/auto.js';
import { searchMemory } from '../memory/search.js';
import { attachmentBlock } from '../attachments/extract.js';

interface ChatBody {
  conversationId?: string;
  message: string;
  projectId?: string;
  personId?: string;
  provider?: string;
  scope?: string;
  attachmentIds?: string[];
}

export async function chatRoutes(app: FastifyInstance) {
  app.post<{ Body: ChatBody }>('/api/chat', async (req: FastifyRequest<{ Body: ChatBody }>, reply: FastifyReply) => {
    const db = getDb();
    const { message, projectId, personId, provider = 'auto', scope = 'global', attachmentIds = [] } = req.body;
    let { conversationId } = req.body;
    const now = new Date().toISOString();

    if (!conversationId) {
      conversationId = uuidv4();
      const title = message.slice(0, 60) || 'New Conversation';
      db.prepare('INSERT INTO conversations(id,title,scope,project_id,person_id,provider,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)').run(
        conversationId, title, scope, projectId ?? null, personId ?? null, provider, now, now
      );
    } else {
      db.prepare('UPDATE conversations SET updated_at=? WHERE id=?').run(now, conversationId);
    }

    // Resolve attachments (only ones not yet bound to a different conversation)
    const atts = attachmentIds.length
      ? db.prepare(`SELECT id,filename,mimetype,size,extracted_text FROM attachments WHERE id IN (${attachmentIds.map(() => '?').join(',')})
                    AND (conversation_id IS NULL OR conversation_id=?)`).all(...attachmentIds, conversationId) as
          { id: string; filename: string; mimetype: string; size: number; extracted_text: string }[]
      : [];
    atts.sort((a, b) => attachmentIds.indexOf(a.id) - attachmentIds.indexOf(b.id));   // keep the order the user attached them
    if (atts.length) {
      db.prepare(`UPDATE attachments SET conversation_id=? WHERE id IN (${atts.map(() => '?').join(',')})`).run(conversationId, ...atts.map(a => a.id));
    }
    const attMeta = JSON.stringify(atts.map(a => ({ id: a.id, filename: a.filename, size: a.size, mimetype: a.mimetype, extracted: a.extracted_text.length > 0 })));

    // Save user message
    db.prepare('INSERT INTO messages(id,conversation_id,role,content,attachments,created_at) VALUES(?,?,?,?,?,?)').run(
      uuidv4(), conversationId, 'user', message, attMeta, now
    );

    // Build conversation history (last 20 messages)
    const history = db.prepare(
      'SELECT role,content FROM messages WHERE conversation_id=? ORDER BY created_at DESC LIMIT 20'
    ).all(conversationId) as { role: string; content: string }[];
    const messages = history.reverse() as Array<{ role: 'user' | 'assistant'; content: string }>;

    // Give the provider the attachment contents for THIS turn (stored message stays clean)
    if (atts.length && messages.length) {
      messages[messages.length - 1].content += atts.map(a => attachmentBlock(a, a.extracted_text.length > 0)).join('');
    }

    // Load relevant memory context
    const memoryContext = getMemoryContext(message, scope, projectId, personId);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*',
      'X-Accel-Buffering': 'no'
    });

    const send = (event: string, data: unknown) => {
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    send('start', { conversationId });

    // Prepend memory context as system context
    if (memoryContext) {
      const withCtx: Array<{ role: 'user' | 'assistant'; content: string }> = [
        { role: 'user', content: `Context from AImax memory:\n${memoryContext}\n\nUse this when relevant to answer my question.` },
        { role: 'assistant', content: 'Understood, I will use this context.' },
        ...messages
      ];
      messages.splice(0, messages.length, ...withCtx);
    }

    let fullResponse = '';
    let usedProvider = provider;
    let usedModel = '';

    try {
      const result = await autoChat(messages, provider, (chunk) => {
        fullResponse += chunk;
        send('chunk', { text: chunk });
      });
      fullResponse = result.text;
      usedProvider = result.provider;
      usedModel = result.model;
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      send('error', { message: errMsg });
      fullResponse = `I encountered an error: ${errMsg}`;
      usedProvider = 'error';
    }

    // Save assistant message
    const assistantMsgId = uuidv4();
    db.prepare('INSERT INTO messages(id,conversation_id,role,content,provider,model,created_at) VALUES(?,?,?,?,?,?,?)').run(
      assistantMsgId, conversationId, 'assistant', fullResponse, usedProvider, usedModel, new Date().toISOString()
    );

    send('done', { conversationId, messageId: assistantMsgId, provider: usedProvider, model: usedModel });
    reply.raw.end();
  });
}

function getMemoryContext(query: string, _scope: string, projectId?: string, personId?: string): string {
  try {
    const rows = searchMemory(query, { projectId, personId }, 5);
    if (!rows.length) return '';
    return rows.map(r => `[${r.title}]: ${r.content}`).join('\n---\n');
  } catch {
    return '';
  }
}
