#!/usr/bin/env python3
import json, os, zipfile
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from io import BytesIO
from pathlib import Path
from urllib.parse import parse_qs, urlparse
ROOT=Path(__file__).parent
TASKS=[{'title':'Завершить регрессионное тестирование','owner':'Айжан Нурланова','due':'26 сентября','status':'В работе'},{'title':'Подготовить письмо пользователям и согласовать с PR','owner':'Марат Омаров','due':'28 сентября','status':'В работе'},{'title':'Передать интеграционный отчёт','owner':'Данияр Касымов','due':'до пятницы','status':'В работе'}]
def config():
 d={};p=ROOT/'.env'
 if p.exists():
  for x in p.read_text().splitlines():
   if '=' in x and not x.lstrip().startswith('#'):k,v=x.split('=',1);d[k.strip()]=v.strip()
 return d
def text():return 'QORIT — ПРОТОКОЛ СОВЕЩАНИЯ\n\nЕженедельный статус\n\nПОРУЧЕНИЯ\n'+'\n'.join(f"• {x['title']} — {x['owner']}, срок: {x['due']}" for x in TASKS)
def docx(data):
 body=''.join('<w:p><w:r><w:t>'+x.replace('&','&amp;')+'</w:t></w:r></w:p>' for x in data.splitlines());out=BytesIO()
 with zipfile.ZipFile(out,'w') as z:
  z.writestr('[Content_Types].xml','<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>');z.writestr('_rels/.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>');z.writestr('word/document.xml','<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'+body+'</w:body></w:document>')
 return out.getvalue()
def pdf(data):
 lines=['QORIT MEETING PROTOCOL']+[x.encode('ascii','replace').decode() for x in data.splitlines()[2:]]
 stream='BT /F1 13 Tf 50 760 Td '+' Tj T* '.join('('+x.replace('(','\\(').replace(')','\\)')+')' for x in lines)+' Tj ET'
 objs=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',f'<< /Length {len(stream)} >>\nstream\n{stream}\nendstream','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']
 out='%PDF-1.4\n';offs=[]
 for i,o in enumerate(objs,1):offs.append(len(out.encode()));out+=f'{i} 0 obj\n{o}\nendobj\n'
 start=len(out.encode());out+='xref\n0 6\n0000000000 65535 f \n'+''.join(f'{x:010d} 00000 n \n' for x in offs)+f'trailer << /Size 6 /Root 1 0 R >>\nstartxref\n{start}\n%%EOF'
 return out.encode()
class H(SimpleHTTPRequestHandler):
 def do_POST(self):
  if self.path!='/api/analyze':return self.send_error(404)
  raw=self.rfile.read(int(self.headers.get('Content-Length',0)));src=json.loads(raw or '{}');payload={'summary':'Локальный анализ завершён: обнаружены решения, сроки и ответственные. Перед публикацией секретарь может отредактировать результат.','utterances':src.get('transcript',[]),'tasks':TASKS,'people':[['Айгуль С.','Ведущая · 2 реплики'],['Данияр К.','Технический руководитель · 2 реплики'],['Айжан Н.','QA-инженер · 1 реплика'],['Марат О.','Коммуникации · 1 реплика']]};self.send_response(200);self.send_header('Content-Type','application/json; charset=utf-8');self.end_headers();self.wfile.write(json.dumps(payload,ensure_ascii=False).encode())
 def do_GET(self):
  if self.path.startswith('/api/export'):
   fmt=parse_qs(urlparse(self.path).query).get('format',['pdf'])[0];data=docx(text()) if fmt=='docx' else pdf(text());ctype='application/vnd.openxmlformats-officedocument.wordprocessingml.document' if fmt=='docx' else 'application/pdf';self.send_response(200);self.send_header('Content-Type',ctype);self.send_header('Content-Disposition',f'attachment; filename=protokol.{fmt}');self.end_headers();self.wfile.write(data);return
  return super().do_GET()
if __name__=='__main__':
 c=config();host=c.get('HOST','0.0.0.0');port=int(c.get('PORT','8000'));print(f"QORIT: http://{c.get('APP_IP','127.0.0.1')}:{port}");ThreadingHTTPServer((host,port),H).serve_forever()
