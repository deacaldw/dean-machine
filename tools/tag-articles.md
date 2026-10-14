# Task: tag every topic in good_articles.json with categories

You're working in the DeanMachine repository. `Skills/TwentyQuestions/good_articles.json` is the list of topics a
20 Questions game picks its secret answer from. Players will soon be able to ask for a category ("80s movies",
"animals", "something about space"), so every topic needs category tags.

## The file

A JSON array of about 3,600 entries:

```json
{
  "name": "Black Panther (character)",
  "url": "https://en.wikipedia.org/wiki/Black_Panther_(character)",
  "obscurity": 2
}
```

Add a `tags` field to **every** entry, after `obscurity`:

```json
{
  "name": "Black Panther (character)",
  "url": "https://en.wikipedia.org/wiki/Black_Panther_(character)",
  "obscurity": 2,
  "tags": ["Comics & superheroes", "Fictional characters", "Films"]
}
```

Change nothing else: keep every entry, the order, the other fields and their values. Keep the formatting:
2-space indentation and LF line endings.

## How to judge an entry

- Judge each entry **by its name**, using what you know about the subject. The part in parentheses tells you which
  subject is meant: "Madonna (album)" is an album, not the singer. Don't look anything up online.
- Give **1 to 3 tags**, the best fit first. Use only tags that a player asking for that category would be happy to
  get this topic for. One accurate tag beats three loose ones.
- Copy tags **exactly** from the list below: same spelling, capitals and "&". Never invent a tag.
- Tag what the topic *is*, then what it's *about* if a player would expect it:
  - "Gollum" → Fictional characters, Fantasy & science fiction, Books & novels
  - "Auschwitz concentration camp" → Wars & battles, Buildings & structures
  - "Dangerous (Michael Jackson album)" → Music
  - "Mikhail Gorbachev" → Politicians & leaders
  - "Detroit-style pizza" → Food & drink
  - "Roosevelt Island Tramway" → Trains & public transport
  - "Lassen Peak" → Mountains & volcanoes
  - "2022 LastPass data breach" → Computers & internet, Crimes & scandals
  - "Sonnet 18" → Poems & plays
- If you don't recognise a name, make your best guess from the name itself. Never leave `tags` empty.

## The 60 categories

People
1. Actors & entertainers (actors, comedians, TV hosts, directors)
2. Musicians & singers (and bands)
3. Writers & poets
4. Artists & architects
5. Scientists, inventors & explorers
6. Politicians & leaders (presidents, prime ministers, activists, reformers)
7. Royalty & nobility (kings, queens, emperors, dynasties)
8. Military people (generals, admirals, soldiers)
9. Athletes
10. Religious figures (prophets, saints, popes, gods worshipped today)

Culture and entertainment
11. Films
12. TV shows
13. Music (albums, genres, instruments, music styles)
14. Books & novels
15. Poems & plays
16. Comics & superheroes
17. Anime & manga
18. Video games
19. Fictional characters
20. Fantasy & science fiction (any topic from or about these genres)
21. Mythology & folklore
22. Paintings & sculpture
23. Fashion & clothing
24. Toys & games (board games, card games, puzzles, toys)
25. Sports (sports, teams, competitions, stadiums)

Places
26. Countries & regions (countries, states, provinces, historic realms)
27. Cities & towns
28. Neighbourhoods & streets (districts, squares, streets)
29. Islands
30. Mountains & volcanoes
31. Rivers, lakes & seas
32. Parks & natural wonders (national parks, caves, deserts, forests)
33. Buildings & structures (skyscrapers, museums, theatres, towers, dams)
34. Bridges, tunnels & roads
35. Monuments & landmarks (statues, memorials, famous sites)
36. Castles, palaces & historic houses
37. Religious buildings (churches, cathedrals, temples, mosques, abbeys)
38. Trains & public transport (railways, stations, metros, trams)

History and society
39. Ancient history (up to about 500 CE)
40. Medieval history (about 500 to 1500)
41. Wars & battles (including sieges, camps, military campaigns)
42. Revolutions & protests (uprisings, strikes, boycotts, movements)
43. Disasters & accidents (earthquakes, crashes, shipwrecks, fires)
44. Crimes & scandals (crimes, criminals, hoaxes, panics)
45. Politics & government (institutions, documents, laws, elections, parties)
46. Religion & beliefs (religions, holy books, rituals, philosophies)
47. Languages & writing (languages, alphabets, famous manuscripts)
48. Holidays & traditions (festivals, customs, celebrations)
49. Companies & brands (and famous restaurants and shops)
50. Money & economy (currencies, trade, banks, economic events)

Science and nature
51. Animals
52. Plants & fungi (including fruit and trees)
53. Human body & medicine (anatomy, diseases, drugs, health)
54. Space & astronomy
55. Physics, chemistry & maths
56. Earth & weather (geology, climate, weather, natural phenomena)

Technology and everyday life
57. Computers & internet (hardware, software, websites, phones, memes)
58. Inventions & everyday objects (tools, machines, household things)
59. Vehicles & aircraft (cars, ships, planes, rockets)
60. Food & drink (dishes, ingredients, drinks, cuisines)

## How to work

There are too many entries to judge in one go, so work in chunks:

1. Write a small Node script (in the scratchpad, not the repository) that writes the names to numbered chunk files
   of 200 entries each, one line per entry: `<index>\t<name>`, where `<index>` is the entry's position in the
   array.
2. For each chunk, read the names and write a JSON file mapping each index to its tags, like
   `{"0": ["Writers & poets"], "1": ["Music"]}`. Judge every name yourself. Don't skip ahead or tag by keyword
   rules in a script.
3. Write a merge script that adds the tags to `good_articles.json` and **checks**:
   - every entry has 1 to 3 tags, with no duplicates;
   - every tag is exactly one of the 60 above;
   - the entry count, the order and all other fields are unchanged (compare with `git show HEAD:<file>`);
   - the file still parses as JSON.
4. Print how many entries each tag got. If a tag has fewer than 15 entries, or more than 400, show me the numbers
   and a few examples before finishing. The list may need adjusting.
5. Then run `npm test` to check nothing else broke.

## When you're done

Report:
- how many entries were tagged;
- the count per tag;
- about 20 random entries with their tags, so I can spot-check them;
- any names you weren't sure about.

Don't commit; I'll review the changes first.
