import os, re
p = os.path.expandvars(r'%USERPROFILE%/.dsh/.credentials.yaml')
txt = open(p, encoding='utf-8').read()
masked = re.sub(r'(?m)(:\s*).+$', r'\1<masked>', txt)
print(masked[:1200])