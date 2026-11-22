use super::*;
use crate::scratch::Scratch;

fn note<'a>(title: &'a str, summary: &'a str) -> NewNote<'a> {
    NewNote {
        title,
        summary,
        body: "",
        replaces: None,
    }
}

#[test]
fn reading_never_makes_a_store() {
    let home = Scratch::new("notes-none");
    assert_eq!(briefing(home.path(), "token"), None);
    let kept = kept(home.path(), "token", true).unwrap();
    assert_eq!(kept.standing, 0);
    assert_eq!(kept.page, None);
    assert!(!folder(home.path()).exists());
}

#[test]
fn the_store_is_in_the_workbench_directory_and_the_users_alone() {
    let home = Scratch::new("notes-own");
    let notes = Notes::open(home.path()).unwrap();
    notes.add("a", &note("One", "First."), 0).unwrap();
    let page = kept(home.path(), "a", true).unwrap().page.unwrap();
    let dir = home.path().join(".chord").join("notes");
    assert!(dir.join(FILE).is_file());
    assert!(Path::new(&page).starts_with(&dir));
    assert!(!home.path().join(FILE).exists());
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = |path: &Path| std::fs::metadata(path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&dir), 0o700);
        assert_eq!(mode(&dir.join(FILE)), 0o600);
        assert_eq!(mode(Path::new(&page)), 0o600);
        assert_eq!(mode(Path::new(&page).parent().unwrap()), 0o700);
        for entry in std::fs::read_dir(&dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_file() {
                assert_eq!(mode(&path) & 0o077, 0, "{}", path.display());
            }
        }
    }
}

#[test]
fn a_note_kept_after_the_point_gone_back_to_is_said_to_be_so() {
    let home = Scratch::new("notes-since");
    let notes = Notes::open(home.path()).unwrap();
    notes.add("a", &note("Before", "Stands."), 100).unwrap();
    notes
        .add("a", &note("After", "Went back on."), 200)
        .unwrap();
    let all = briefing_since(home.path(), "a", Some(150)).unwrap();
    let line = |title: &str| {
        all.lines()
            .find(|line| line.contains(title))
            .unwrap()
            .to_string()
    };
    assert!(!line("Before").contains("went back on"));
    assert!(line("After").contains("kept on a turn the conversation went back on"));
    assert!(!briefing(home.path(), "a")
        .unwrap()
        .contains("went back on:"));
}

#[test]
fn a_brief_and_notes_are_kept_per_session() {
    let home = Scratch::new("notes-kept");
    let notes = Notes::open(home.path()).unwrap();
    notes
        .set_brief("a", "A desktop app for agents.", 0)
        .unwrap();
    notes
        .set_brief("a", "Chord, a desktop app for agents.", 86_400)
        .unwrap();
    let first = notes
        .add(
            "a",
            &note("Default model", "One tier below the starter."),
            86_400,
        )
        .unwrap();
    notes
        .add("b", &note("Other", "Another session's."), 0)
        .unwrap();

    let listed = notes.listed("a").unwrap();
    assert_eq!(
        listed.brief.as_ref().unwrap().text,
        "Chord, a desktop app for agents."
    );
    assert_eq!(listed.notes.len(), 1);
    assert_eq!(listed.notes[0].id, first);
    let text = briefing(home.path(), "a").unwrap();
    assert!(text.starts_with("Brief (1970-01-02):\n> Chord, a desktop app for agents."));
    assert!(text.contains(&format!(
        "\n> #{first} 1970-01-02 Default model: One tier below the starter."
    )));
    assert!(!text.contains("Another session's"));
}

#[test]
fn a_later_note_replaces_an_earlier_one() {
    let home = Scratch::new("notes-replace");
    let notes = Notes::open(home.path()).unwrap();
    let old = notes
        .add("a", &note("Threshold", "100k tokens."), 0)
        .unwrap();
    let new = notes
        .add(
            "a",
            &NewNote {
                replaces: Some(old),
                ..note("Threshold", "150k tokens.")
            },
            1,
        )
        .unwrap();
    let listed = notes.listed("a").unwrap();
    assert_eq!(
        listed.notes.iter().map(|n| n.id).collect::<Vec<_>>(),
        vec![new]
    );
    let read = notes.read("a", old).unwrap().unwrap();
    assert_eq!(read.replaced_by, Some(new));
    assert!(whole(&read).starts_with(&format!("Replaced by #{new}.")));
    // A note already replaced, or another session's, cannot be replaced.
    let again = NewNote {
        replaces: Some(old),
        ..note("x", "y")
    };
    assert!(notes
        .add("a", &again, 2)
        .unwrap_err()
        .contains(&format!("#{new}")));
    assert!(notes.add("b", &again, 2).unwrap_err().contains("no note"));
}

#[test]
fn the_list_is_bounded_to_the_newest_and_the_most_read() {
    let home = Scratch::new("notes-bounded");
    let notes = Notes::open(home.path()).unwrap();
    let ids: Vec<i64> = (0..60)
        .map(|n| {
            notes
                .add("a", &note(&format!("Note {n}"), "Said."), n)
                .unwrap()
        })
        .collect();
    // The oldest is read often, so it stays on the list.
    for _ in 0..3 {
        notes.read("a", ids[0]).unwrap();
    }
    let listed = notes.listed("a").unwrap();
    assert_eq!(listed.notes.len(), NEWEST + 1);
    assert_eq!(listed.more, 60 - NEWEST - 1);
    assert_eq!(listed.notes[0].id, ids[59]);
    assert_eq!(listed.notes.last().unwrap().id, ids[0]);
    let text = briefing_of(&listed).unwrap();
    assert!(text.ends_with(&format!(
        "And {} more, found by their words with the notes tool.",
        60 - NEWEST - 1
    )));
}

#[test]
fn find_takes_every_word_and_ranks_the_head_first() {
    let home = Scratch::new("notes-find");
    let notes = Notes::open(home.path()).unwrap();
    let in_body = notes
        .add(
            "a",
            &NewNote {
                body: "The cache lifetime is an hour.",
                ..note("Prices", "What a turn costs.")
            },
            0,
        )
        .unwrap();
    let in_title = notes
        .add("a", &note("Cache lifetime", "Read from the transcript."), 1)
        .unwrap();
    notes
        .add("a", &note("Unrelated", "Nothing here."), 2)
        .unwrap();
    let found: Vec<i64> = notes
        .find("a", "CACHE lifetime")
        .unwrap()
        .iter()
        .map(|n| n.id)
        .collect();
    assert_eq!(found, vec![in_title, in_body]);
    assert!(notes.find("a", "cache missing").unwrap().is_empty());
    assert!(notes.find("b", "cache").unwrap().is_empty());
}

#[test]
fn a_note_needs_a_title_and_a_summary_of_a_bounded_length() {
    let home = Scratch::new("notes-limits");
    let notes = Notes::open(home.path()).unwrap();
    assert!(notes.add("a", &note("", "x"), 0).is_err());
    assert!(notes.add("a", &note("x", " "), 0).is_err());
    let long = "x".repeat(TITLE_MOST + 1);
    assert!(notes
        .add("a", &note(&long, "x"), 0)
        .unwrap_err()
        .contains("120"));
    assert!(notes.set_brief("a", "  ", 0).is_err());
    // A title or summary is one line, its spaces folded.
    let id = notes.add("a", &note("Two\nlines", "a  b"), 0).unwrap();
    let kept = notes.note("a", id).unwrap().unwrap();
    assert_eq!(
        (kept.title.as_str(), kept.summary.as_str()),
        ("Two lines", "a b")
    );
}

#[test]
fn forgetting_lets_go_of_the_notes_and_their_page() {
    let home = Scratch::new("notes-forget");
    let notes = Notes::open(home.path()).unwrap();
    notes.set_brief("a", "Brief.", 0).unwrap();
    notes.add("a", &note("One", "First."), 0).unwrap();
    notes.add("b", &note("Two", "Second."), 0).unwrap();
    let page = kept(home.path(), "a", true).unwrap().page.unwrap();
    let written = std::fs::read_to_string(&page).unwrap();
    assert!(written.contains("## Brief\n\nBrief."));
    assert!(written.contains("### One"));
    notes.change_items("a", &["Owed"], &[], 0).unwrap();
    forget(home.path(), &["a".to_string()]).unwrap();
    assert!(!Path::new(&page).exists());
    assert!(!Path::new(&page).parent().unwrap().exists());
    assert_eq!(briefing(home.path(), "a"), None);
    assert_eq!(kept(home.path(), "b", false).unwrap().standing, 1);
}

#[test]
fn items_are_opened_and_closed_and_a_closed_one_is_kept_with_its_day() {
    let home = Scratch::new("notes-items");
    let notes = Notes::open(home.path()).unwrap();
    let opened = notes
        .change_items(
            "a",
            &["Build the export dialog,\n as agreed", "Ask which licence"],
            &[],
            86_400,
        )
        .unwrap();
    assert_eq!(opened.len(), 2);
    let other = notes.change_items("b", &["Another's"], &[], 0).unwrap()[0];
    assert_eq!(
        notes.open_items("a").unwrap()[0].text,
        "Build the export dialog, as agreed"
    );
    // Closing and opening go together in one change.
    let merged = notes
        .change_items(
            "a",
            &["Ask which licence, by Friday"],
            &[opened[1]],
            2 * 86_400,
        )
        .unwrap()[0];
    let open: Vec<i64> = notes
        .open_items("a")
        .unwrap()
        .iter()
        .map(|i| i.id)
        .collect();
    assert_eq!(open, vec![opened[0], merged]);
    let all = notes.items("a").unwrap();
    let closed = all.iter().find(|item| item.id == opened[1]).unwrap();
    assert_eq!(closed.closed, Some(2 * 86_400));
    assert_eq!(closed.text, "Ask which licence");
    // Only the owner's open items close, and a refused change keeps nothing.
    let refused = notes
        .change_items("a", &["Never kept"], &[opened[1]], 0)
        .unwrap_err();
    assert!(
        refused.contains("closed already, on 1970-01-03"),
        "{refused}"
    );
    assert!(notes
        .change_items("a", &[], &[other], 0)
        .unwrap_err()
        .contains(&format!("no item {other}")));
    assert_eq!(notes.items("a").unwrap().len(), 3);
    assert_eq!(notes.open_items("b").unwrap().len(), 1);
}

#[test]
fn open_items_are_bounded_and_one_more_is_refused_never_dropped() {
    let home = Scratch::new("notes-items-bounded");
    let notes = Notes::open(home.path()).unwrap();
    let texts: Vec<String> = (0..ITEMS_MOST).map(|n| format!("Owed {n}")).collect();
    let ids = notes
        .change_items(
            "a",
            &texts.iter().map(String::as_str).collect::<Vec<_>>(),
            &[],
            0,
        )
        .unwrap();
    let refused = notes.change_items("a", &["One more"], &[], 0).unwrap_err();
    assert!(refused.contains("close those done or dropped"), "{refused}");
    assert!(refused.contains("merge"), "{refused}");
    let open = notes.open_items("a").unwrap();
    assert_eq!(open.len(), ITEMS_MOST);
    assert_eq!(open[0].text, "Owed 0");
    // At the bound, closing one makes room for one in the same change.
    notes
        .change_items("a", &["One more"], &[ids[0]], 1)
        .unwrap();
    assert_eq!(notes.open_items("a").unwrap().len(), ITEMS_MOST);
    // An item is one line of a bounded length.
    let long = "x".repeat(ITEM_MOST + 1);
    assert!(notes
        .change_items("a", &[long.as_str()], &[ids[1]], 1)
        .unwrap_err()
        .contains(&ITEM_MOST.to_string()));
    assert!(notes.change_items("a", &[" \n "], &[ids[1]], 1).is_err());
    assert_eq!(notes.open_items("a").unwrap()[0].id, ids[1]);
}

#[test]
fn the_briefing_gives_the_open_items_first_whole_and_leaves_the_closed_out() {
    let home = Scratch::new("notes-items-briefing");
    let notes = Notes::open(home.path()).unwrap();
    let long = format!("Port the importer {}", "and its tests ".repeat(12));
    let ids = notes
        .change_items("a", &[long.as_str(), "Done soon"], &[], 100)
        .unwrap();
    // Open items alone are a briefing.
    assert!(briefing(home.path(), "a")
        .unwrap()
        .starts_with("Open items, what is still owed,"));
    notes
        .change_items("a", &["Went back on"], &[ids[1]], 200)
        .unwrap();
    notes.set_brief("a", "Chord.", 0).unwrap();
    let note = notes
        .add("a", &note("Default model", "Sonnet."), 0)
        .unwrap();
    let text = briefing_since(home.path(), "a", Some(150)).unwrap();
    let items = text.find("Open items").unwrap();
    let brief = text.find("Brief (").unwrap();
    let listed = text.find(&format!("> #{note} ")).unwrap();
    assert!(items < brief && brief < listed, "{text}");
    assert!(text.contains(&format!("\n> {}. 1970-01-01 {}\n", ids[0], long.trim())));
    let line = |text: &str, words: &str| {
        text.lines()
            .find(|line| line.contains(words))
            .unwrap_or_else(|| panic!("{text}"))
            .to_string()
    };
    assert!(line(&text, "Went back on").contains("opened on a turn the conversation went back on"));
    // Closed on a turn gone back on, it is owed again, among the open ones.
    let again = line(&text, "Done soon");
    assert!(again.starts_with(&format!("> {}. ", ids[1])), "{again}");
    assert!(
        again.contains("closed on a turn the conversation went back on: its work may be undone")
    );
    assert!(text.find("Done soon").unwrap() < brief, "{text}");
    // Not held, or held after it was closed, it is left out.
    assert!(!briefing(home.path(), "a").unwrap().contains("Done soon"));
    assert!(!briefing_since(home.path(), "a", Some(250))
        .unwrap()
        .contains("Done soon"));
    // Nor does it count toward the bound.
    let more: Vec<String> = (0..ITEMS_MOST - 2).map(|n| format!("Owed {n}")).collect();
    notes
        .change_items(
            "a",
            &more.iter().map(String::as_str).collect::<Vec<_>>(),
            &[],
            300,
        )
        .unwrap();
    assert_eq!(notes.open_items("a").unwrap().len(), ITEMS_MOST);
}

/// Two sessions writing at once through their own connections cannot pass
/// the bound between them: with five open, each opening seven, one waits
/// for the other, then is refused.
#[test]
fn two_writers_at_once_cannot_pass_the_bound() {
    let home = Scratch::new("notes-items-two-writers");
    let first: Vec<String> = (0..ITEMS_MOST - 7).map(|n| format!("Owed {n}")).collect();
    Notes::open(home.path())
        .unwrap()
        .change_items(
            "a",
            &first.iter().map(String::as_str).collect::<Vec<_>>(),
            &[],
            0,
        )
        .unwrap();
    let start = std::sync::Arc::new(std::sync::Barrier::new(2));
    let writers: Vec<_> = (0..2)
        .map(|writer| {
            let (home, start) = (home.path().to_path_buf(), start.clone());
            std::thread::spawn(move || {
                let notes = Notes::open(&home).unwrap();
                let texts: Vec<String> = (0..7).map(|n| format!("Writer {writer}, {n}")).collect();
                start.wait();
                notes.change_items(
                    "a",
                    &texts.iter().map(String::as_str).collect::<Vec<_>>(),
                    &[],
                    0,
                )
            })
        })
        .collect();
    let done: Vec<_> = writers.into_iter().map(|one| one.join().unwrap()).collect();
    assert_eq!(done.iter().filter(|one| one.is_ok()).count(), 1, "{done:?}");
    let refused = done.iter().find_map(|one| one.clone().err()).unwrap();
    assert!(
        refused.contains("That would make 19 open items"),
        "{refused}"
    );
    assert_eq!(
        Notes::open(home.path())
            .unwrap()
            .open_items("a")
            .unwrap()
            .len(),
        ITEMS_MOST
    );
}

#[test]
fn the_page_has_the_open_items_first_and_the_closed_last() {
    let home = Scratch::new("notes-items-page");
    let notes = Notes::open(home.path()).unwrap();
    let ids = notes
        .change_items("a", &["Still owed", "Was owed"], &[], 0)
        .unwrap();
    notes.change_items("a", &[], &[ids[1]], 86_400).unwrap();
    let told = kept(home.path(), "a", false).unwrap();
    assert_eq!((told.open, told.standing, told.brief), (1, 0, false));
    notes.set_brief("a", "Brief.", 0).unwrap();
    let page =
        std::fs::read_to_string(kept(home.path(), "a", true).unwrap().page.unwrap()).unwrap();
    assert!(page.find("## Open items").unwrap() < page.find("## Brief").unwrap());
    assert!(page.contains(&format!(
        "## Open items\n\n- Still owed · *opened 1970-01-01 · item {}*\n",
        ids[0]
    )));
    assert!(page.ends_with(&format!(
        "## Closed items\n\n- Was owed · *opened 1970-01-01 · closed 1970-01-02 · item {}*\n",
        ids[1]
    )));
    forget(home.path(), &["a".to_string()]).unwrap();
    assert!(notes.items("a").unwrap().is_empty());
}

#[test]
fn a_store_kept_before_items_opens_with_its_notes_as_they_were() {
    let home = Scratch::new("notes-items-older");
    let dir = folder(home.path());
    std::fs::create_dir_all(&dir).unwrap();
    let conn = Connection::open(dir.join(FILE)).unwrap();
    conn.execute_batch(
        "CREATE TABLE briefs (owner TEXT PRIMARY KEY, text TEXT NOT NULL, at INTEGER NOT NULL);
        CREATE TABLE notes (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            owner TEXT NOT NULL,
            title TEXT NOT NULL,
            summary TEXT NOT NULL,
            body TEXT NOT NULL,
            at INTEGER NOT NULL,
            replaces INTEGER,
            replaced_by INTEGER,
            reads INTEGER NOT NULL DEFAULT 0
        );
        CREATE INDEX notes_by_owner ON notes (owner, id);
        INSERT INTO briefs VALUES ('a', 'Chord.', 0);
        INSERT INTO notes (owner, title, summary, body, at, reads)
            VALUES ('a', 'Kept', 'Before items.', 'Body.', 0, 2);",
    )
    .unwrap();
    drop(conn);

    let notes = Notes::open(home.path()).unwrap();
    let kept = notes.all("a").unwrap();
    assert_eq!(kept.len(), 1);
    assert_eq!(
        (kept[0].title.as_str(), kept[0].body.as_str(), kept[0].reads),
        ("Kept", "Body.", 2)
    );
    assert_eq!(notes.brief("a").unwrap().unwrap().text, "Chord.");
    assert!(notes.items("a").unwrap().is_empty());
    notes.change_items("a", &["Owed"], &[], 0).unwrap();
    assert_eq!(notes.open_items("a").unwrap().len(), 1);
}

#[test]
fn days_are_civil_dates() {
    assert_eq!(day(0), "1970-01-01");
    assert_eq!(day(951_782_400), "2000-02-29");
    assert_eq!(day(1_795_046_400), "2026-11-19");
}

#[test]
fn a_page_path_keeps_to_the_folder() {
    let home = Path::new("/home");
    assert_eq!(
        page_path(home, "../x"),
        Path::new("/home")
            .join(".chord")
            .join("notes")
            .join("___x")
            .join(PAGE_NAME)
    );
}
