"""Range-download a receipted object, then use unchanged native crypto/restore checks."""
import argparse,hashlib,importlib.util,json,tempfile
from pathlib import Path
from types import SimpleNamespace
from boto3.s3.transfer import TransferConfig
p=argparse.ArgumentParser();p.add_argument('--receipt',type=Path,required=True);p.add_argument('--destination',type=Path,required=True);p.add_argument('--ciphertext',type=Path);p.add_argument('--native-tool',type=Path,default=Path('/home/boxes/rose/docs/handoffs/whm-b07d9037-preservation/private_archive.py'));args=p.parse_args()
spec=importlib.util.spec_from_file_location('native_archive',args.native_tool);native=importlib.util.module_from_spec(spec);spec.loader.exec_module(native)
receipt=json.loads(args.receipt.read_text());client,_,aes,key_id=native.connection()
with tempfile.TemporaryDirectory(prefix='private-archive-readback-') as folder:
 cipher=args.ciphertext or Path(folder)/'archive.enc'
 if args.ciphertext is None:
  client.download_file(receipt['bucket'],receipt['key'],str(cipher),Config=TransferConfig(multipart_threshold=8*1024*1024,multipart_chunksize=8*1024*1024,max_concurrency=4,num_download_attempts=5))
 digest=hashlib.sha256()
 with cipher.open('rb') as stream:
  for chunk in iter(lambda:stream.read(1024*1024),b''):digest.update(chunk)
 if cipher.stat().st_size!=receipt['stored_bytes'] or digest.hexdigest()!=receipt['ciphertext_sha256']:raise RuntimeError('Downloaded object differs from the verified receipt')
 class ObjectFileClient:
  def get_object(self,*,Bucket,Key):
   if Bucket!=receipt['bucket'] or Key!=receipt['key']:raise RuntimeError('Wrong archive identity')
   return {'Body':cipher.open('rb')}
 original=native.connection
 native.connection=lambda:(ObjectFileClient(),receipt['bucket'],aes,key_id)
 try:native.restore(SimpleNamespace(receipt=str(args.receipt),destination=str(args.destination)))
 finally:native.connection=original
 print(json.dumps({'all_native_restore_hashes_verified':True,'files':receipt['files'],'original_bytes':receipt['original_bytes'],'ciphertext_sha256':receipt['ciphertext_sha256'],'destination':str(args.destination),'overlaid_live_workspace':False}))
