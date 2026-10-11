#!/usr/bin/env python3
"""Local macOS iMessage ingestor. Reads SQLite; writes only through Memory API."""
import argparse
import datetime as dt
import json
import mimetypes
import os
from pathlib import Path
import shlex
import socket
import sqlite3
import time
import urllib.request
import uuid


def timestamp(value):
    seconds = value / 1e9 if abs(value) > 1e12 else value
    return dt.datetime.fromtimestamp(seconds + 978307200, dt.timezone.utc).isoformat()


def request(config, path, data, content_type='application/json', method='POST'):
    req=urllib.request.Request(config['MEMORY_DATABASE_API_URL'].rstrip('/')+path,data=data,method=method,
        headers={'Authorization':'Bearer '+config['MEMORY_DATABASE_API_WRITE_TOKEN'],
                 'Content-Type':content_type,'User-Agent':'Mozilla/5.0 LocalMemoryIngestor/1.0'})
    with urllib.request.urlopen(req,timeout=90) as response:
        return json.load(response)


def upload(config,message,attachments):
    boundary='memory-'+uuid.uuid4().hex
    body=bytearray()
    metadata=[]
    for att,path in attachments:
        metadata.append({'original_file_name':att['transfer_name'] or path.name,
                         'provider':'imessage','provider_attachment_id':att['guid'],'role':'original'})
    for key,value in [('message',message),('attachments_meta',metadata)]:
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="{key}"\r\n\r\n'.encode())
        body.extend(json.dumps(value).encode()); body.extend(b'\r\n')
    for att,path in attachments:
        name=path.name.replace('"','_').replace('\r','_').replace('\n','_')
        mime=att['mime_type'] or mimetypes.guess_type(name)[0] or 'application/octet-stream'
        body.extend(f'--{boundary}\r\nContent-Disposition: form-data; name="files"; filename="{name}"\r\nContent-Type: {mime}\r\n\r\n'.encode())
        body.extend(path.read_bytes()); body.extend(b'\r\n')
    body.extend(f'--{boundary}--\r\n'.encode())
    # Retry of an unchanged source record is idempotent; this also lets missing
    # local attachment bytes be attached later without rewriting message text.
    return request(config,'/api/messages/ingest?conflict_mode=skip_or_append',bytes(body),'multipart/form-data; boundary='+boundary)


def run(config,args):
    state_path=Path(args.state).expanduser()
    state=json.loads(state_path.read_text()) if state_path.exists() else {'last_rowid':0,'retry':[]}
    db=sqlite3.connect('file:'+str(Path(args.database).expanduser())+'?mode=ro',uri=True)
    db.row_factory=sqlite3.Row
    since=dt.datetime.fromisoformat(args.since.replace('Z','+00:00')).timestamp()
    apple_since=int((since-978307200)*1e9)
    retry=state.get('retry',[])[:50]
    placeholders=','.join('?' for _ in retry) or 'NULL'
    rows=db.execute(f'''SELECT m.ROWID AS rowid,m.guid,m.text,m.attributedBody IS NOT NULL AS has_attributed,
        m.date,m.is_from_me,m.service,m.cache_has_attachments,m.reply_to_guid,h.id AS sender,
        c.ROWID AS chat_id,c.chat_identifier,c.display_name
        FROM message m LEFT JOIN handle h ON h.ROWID=m.handle_id
        LEFT JOIN chat c ON c.ROWID=(SELECT chat_id FROM chat_message_join WHERE message_id=m.ROWID LIMIT 1)
        WHERE (m.ROWID>? AND m.date>=?) OR m.ROWID IN ({placeholders})
        ORDER BY m.ROWID LIMIT ?''',[state['last_rowid'],apple_since,*retry,args.limit]).fetchall()
    report={'source':'imessage','hostname':socket.gethostname(),'scanned':len(rows),'written':0,'attachments_missing':0,'text_unavailable':0,'failed':0}
    latest=None
    for row in rows:
        if args.dry_run: continue
        records=db.execute('''SELECT a.guid,a.filename,a.transfer_name,a.mime_type FROM attachment a
            JOIN message_attachment_join j ON j.attachment_id=a.ROWID WHERE j.message_id=?''',[row['rowid']]).fetchall()
        available=[]; missing=[]
        for att in records:
            path=Path(att['filename'] or '').expanduser()
            if path.is_file() and path.stat().st_size<=32*1024*1024:
                available.append((att,path))
            else: missing.append(att['guid'])
        if len(available)>10:
            missing.extend(att['guid'] for att,_ in available[10:]); available=available[:10]
        text=(row['text'] or '').strip()
        text_missing=not text and bool(row['has_attributed']) and not records
        report['text_unavailable']+=int(text_missing)
        metadata={'chat_id':row['chat_id'],'chat_identifier':row['chat_identifier'],
            'conversation_id':row['chat_identifier'] or str(row['chat_id']) if row['chat_id'] else None,
            'service':row['service'],'is_from_me':bool(row['is_from_me']),
            'reply_to_guid':row['reply_to_guid'],'hasAttachments':bool(records),
            'attachment_ids':[att['guid'] for att in records],'source_text_unavailable':text_missing,
            'kind':'human_message','ingestor':'local-imessage'}
        message={'source':'imessage','external_id':row['guid'],'sender':'ET' if row['is_from_me'] else row['sender'],
            'recipient':row['chat_identifier'],'timestamp':timestamp(row['date']),
            'content':text or ('[Message with attachments]' if records else '[Message text unavailable]'),'metadata':metadata}
        try:
            result=upload(config,message,available)
            if not result.get('message',{}).get('record_id'): raise ValueError('No confirmed record ID')
        except Exception as error:
            report['failed']+=1; report['error']=type(error).__name__; report['error_detail']=str(error)[:200]; break
        report['written']+=1; report['attachments_missing']+=len(missing)
        state['last_rowid']=max(state['last_rowid'],row['rowid'])
        state['retry']=[x for x in state.get('retry',[]) if x!=row['rowid']]
        if missing: state['retry'].append(row['rowid'])
        latest=message['timestamp']
        state_path.parent.mkdir(parents=True,exist_ok=True)
        temporary=state_path.with_suffix('.tmp')
        temporary.write_text(json.dumps(state)); temporary.chmod(0o600); temporary.replace(state_path)
    db.close()
    if not args.dry_run:
        now=dt.datetime.now(dt.timezone.utc).isoformat()
        error=report.get('error') or ('Attachment bytes or message text unavailable locally' if report['attachments_missing'] or report['text_unavailable'] else None)
        heartbeat={'source':'imessage','last_run_at':now,'error_message':error,'metadata':report}
        if not error: heartbeat['last_sync_date']=now
        if latest: heartbeat['last_record_date']=latest[:10]
        request(config,'/api/sync-state/local-imessage:'+socket.gethostname(),json.dumps(heartbeat).encode(),method='PUT')
    print(json.dumps(report),flush=True)
    return len(rows)>=args.limit and not report['failed'] and not state.get('retry')


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--env',required=True)
    parser.add_argument('--database',default='~/Library/Messages/chat.db')
    parser.add_argument('--state',default='~/.local/share/memory-ingestors/imessage.json')
    parser.add_argument('--since',required=True,help='ISO date for the initial import window')
    parser.add_argument('--limit',type=int,default=200)
    parser.add_argument('--interval',type=int,default=0)
    parser.add_argument('--dry-run',action='store_true')
    args=parser.parse_args()
    config={}
    for line in Path(args.env).expanduser().read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            k,v=line.split('=',1); words=shlex.split(v); config[k]=words[0] if words else ''
    while True:
        try: backlog=run(config,args)
        except Exception as error:
            print(json.dumps({'source':'imessage','error':type(error).__name__,'error_detail':str(error)[:200]}),flush=True); backlog=False
            if not args.interval: raise
        if not args.interval or args.dry_run: break
        time.sleep(2 if backlog else args.interval)


if __name__=='__main__': main()
