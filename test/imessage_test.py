import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec=importlib.util.spec_from_file_location('imessage',Path(__file__).parents[1]/'connectors/imessage.py')
imessage=importlib.util.module_from_spec(spec)
spec.loader.exec_module(imessage)


class LocalCollectorTest(unittest.TestCase):
    def test_checkpoint_only_follows_confirmed_writes_and_retry_is_safe(self):
        with tempfile.TemporaryDirectory() as tmp:
            dbpath=Path(tmp)/'chat.db'; state=Path(tmp)/'state.json'
            db=sqlite3.connect(dbpath)
            db.executescript('''
              CREATE TABLE message(guid,text,attributedBody,date,is_from_me,service,cache_has_attachments,reply_to_guid,handle_id);
              CREATE TABLE handle(id);
              CREATE TABLE chat(chat_identifier,display_name);
              CREATE TABLE chat_message_join(chat_id,message_id);
              CREATE TABLE attachment(guid,filename,transfer_name,mime_type);
              CREATE TABLE message_attachment_join(attachment_id,message_id);
              INSERT INTO handle VALUES('person@example.test');
              INSERT INTO chat VALUES('stable-chat','Test');
              INSERT INTO message VALUES('guid-one','first',NULL,800000000000000000,0,'iMessage',0,NULL,1);
              INSERT INTO message VALUES('guid-two','second',NULL,800000001000000000,1,'iMessage',0,NULL,1);
              INSERT INTO chat_message_join VALUES(1,1),(1,2);
            ''');db.close()
            args=SimpleNamespace(state=str(state),database=str(dbpath),since='2026-01-01T00:00:00Z',limit=200,dry_run=False)
            with patch.object(imessage,'request',return_value={}),contextlib.redirect_stdout(io.StringIO()):
                with patch.object(imessage,'upload',side_effect=[{'message':{'record_id':'one'}},OSError('offline')]):
                    imessage.run({},args)
                self.assertEqual(json.loads(state.read_text())['last_rowid'],1)
                with patch.object(imessage,'upload',return_value={'message':{'record_id':'two'}}) as upload:
                    imessage.run({},args)
                    self.assertEqual(upload.call_count,1)
                    self.assertEqual(upload.call_args.args[1]['external_id'],'guid-two')
                with patch.object(imessage,'upload') as upload:
                    imessage.run({},args);upload.assert_not_called()


if __name__=='__main__': unittest.main()
