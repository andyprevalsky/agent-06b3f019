import Database from 'better-sqlite3';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { IMessageData } from '../../shared/types/ipc';

const IMESSAGE_DB_PATH = path.join(
  app.getPath('home'),
  'Library/Messages/chat.db'
);

export class IMessageReader {
  static checkAccess(): boolean {
    try {
      fs.accessSync(IMESSAGE_DB_PATH, fs.constants.R_OK);
      return true;
    } catch {
      return false;
    }
  }
  
  static readMessages(): IMessageData[] {
    if (!this.checkAccess()) {
      throw new Error('No access to iMessage database. Grant Full Disk Access in System Preferences.');
    }
    
    const db = new Database(IMESSAGE_DB_PATH, { readonly: true });
    
    try {
      const messages = db.prepare(`
        SELECT 
          m.ROWID as id,
          m.text,
          m.date,
          m.is_from_me,
          h.id as contact_id,
          COALESCE(c.display_name, h.id) as contact_name
        FROM message m
        LEFT JOIN handle h ON m.handle_id = h.ROWID
        LEFT JOIN chat_handle_join chj ON h.ROWID = chj.handle_id
        LEFT JOIN chat c ON chj.chat_id = c.ROWID
        WHERE m.text IS NOT NULL
        ORDER BY m.date DESC
        LIMIT 10000
      `).all() as IMessageData[];
      
      return messages;
    } finally {
      db.close();
    }
  }
}


