import re
SENSITIVE=re.compile(r'(?i).*(api[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|authorization|password|secret|cvv2?|cvc2?|card[_-]?number|one_time_payment_card_number|security_code|cardSecurityCode|exp_month|exp_year|expiration_date|expiry).*')
def mask(v,key=''):
 if isinstance(v,dict):return {k:('[REDACTED]' if SENSITIVE.match(k) and x else mask(x,k)) for k,x in v.items()}
 if isinstance(v,list):return [mask(x,key) for x in v]
 if not isinstance(v,str):return v
 v=re.sub(r'\bapikey_[A-Za-z0-9_]+','[REDACTED_KEY]',v)
 v=re.sub(r'(?i)\bBearer\s+[A-Za-z0-9_.+/=-]+','Bearer [REDACTED]',v)
 if v.startswith('trace-archive/'):return v  # Preserve exact non-secret archive provenance identifiers.
 uu=[]
 def save(m):uu.append(m.group());return 'UUIDPLACEHOLDER'+chr(65+len(uu)//26)+chr(65+len(uu)%26)
 v=re.sub(r'\b[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}\b',save,v)
 v=re.sub(r'(?<![A-Za-z0-9])(?:\d[ -]?){12,18}\d(?![A-Za-z0-9])','[REDACTED_POSSIBLE_CARD]',v)
 v=re.sub(r'(?i)((?:cvv|cvc|security code|card verification)[\s"\x27:=]*(?:is\s*)?)\d{3,4}',r'\1[REDACTED]',v)
 v=re.sub(r'(?i)((?:api[_ -]?key|access[_ -]?token|authorization|password|secret)[\s"\x27:=]+)[A-Za-z0-9_./+=:-]{8,}',r'\1[REDACTED]',v)
 v=re.sub(r'\b(?:sk|pk)_(?:live|test)_[A-Za-z0-9]+','[REDACTED_KEY]',v)
 v=re.sub(r'(?i)((?:expir(?:y|ation)|exp)[\s"\x27:=]+)\d{1,2}\s*[/\-]\s*\d{2,4}',r'\1[REDACTED]',v)
 for n,u in enumerate(uu,1):v=v.replace('UUIDPLACEHOLDER'+chr(65+n//26)+chr(65+n%26),u)
 return v
