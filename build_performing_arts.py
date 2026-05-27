import json

with open('../Schoology/output/users.json') as f:
    d = json.load(f)
users = d['users']

name_to_username = {}
for uid, u in users.items():
    email = u.get('primary_email', '')
    if '@pinewood.edu' in email:
        username = email.split('@')[0]
        full_name = u.get('name_display', '').strip()
        if full_name:
            name_to_username[full_name.lower()] = username

members = [
    "Naomi Borao", "Malaika Boros", "Nox Bradley", "Alex Bull", "Gwen Chang",
    "Rishi Chen", "Leelah Choi", "Darsh Dwarak", "Alexis Eaton", "Beckett Eaton",
    "Clemence Gaillard", "Zachary Gill", "Ryan Gustavson", "Lola Hannelly",
    "Sahana Inumpudi", "Esha Joshi", "Hattie Kaufmann", "Trevor Koo",
    "Billy Lloyd", "Ellis Matula", "Addison Parenti", "Julian Porter-Shulz",
    "Max Rees", "Leila Saeidi", "Yichen Wang", "Jerry Yan"
]

results = []
not_found = []
for name in members:
    username = name_to_username.get(name.lower())
    if username:
        results.append(username)
    else:
        not_found.append(name)
        results.append(None)

print("NOT FOUND:")
for n in not_found:
    print(f"  {n}")
    # fuzzy search
    first = n.split()[0].lower()
    last = n.split()[-1].lower()
    matches = [(u.get('name_display',''), u.get('primary_email','')) for u in users.values() if last in u.get('name_display','').lower()]
    if matches:
        print(f"    candidates: {matches}")

print(f"\nResolved {len(results) - len(not_found)}/{len(results)}")
