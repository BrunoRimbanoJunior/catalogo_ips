use std::time::{SystemTime, UNIX_EPOCH};

pub fn current_year() -> i32 {
    let seconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs() as i64)
        .unwrap_or(0);
    year_from_unix_days(seconds / 86_400)
}

fn year_from_unix_days(days: i64) -> i32 {
    let z = days + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let month = mp + if mp < 10 { 3 } else { -9 };
    (y + if month <= 2 { 1 } else { 0 }) as i32
}

pub fn vehicle_years_from_name(name: &str, current_year: i32) -> String {
    let ranges = year_ranges_from_text(name, current_year);
    if ranges.is_empty() {
        return String::new();
    }

    let mut short_years = Vec::new();
    let mut full_years = Vec::new();
    for (start, end) in ranges {
        if start > end {
            continue;
        }
        for year in start..=end {
            push_unique(&mut short_years, format!("{:02}", year.rem_euclid(100)));
            push_unique(&mut full_years, year.to_string());
        }
    }

    short_years.extend(full_years);
    short_years.join(",")
}

pub fn search_year_aliases(token: &str, current_year: i32) -> Option<Vec<String>> {
    let clean = token.trim();
    if clean.is_empty() || !clean.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }

    match clean.len() {
        2 => {
            let short = clean.parse::<i32>().ok()?;
            let full = two_digit_to_year(short, current_year);
            Some(unique_values(vec![format!("{short:02}"), full.to_string()]))
        }
        4 => {
            let full = clean.parse::<i32>().ok()?;
            if !(1900..=current_year + 30).contains(&full) {
                return None;
            }
            Some(unique_values(vec![
                full.to_string(),
                format!("{:02}", full.rem_euclid(100)),
            ]))
        }
        _ => None,
    }
}

fn year_ranges_from_text(text: &str, current_year: i32) -> Vec<(i32, i32)> {
    let bytes = text.as_bytes();
    let mut ranges = Vec::new();
    let mut i = 0usize;

    while i < bytes.len() {
        if !bytes[i].is_ascii_digit() {
            i += 1;
            continue;
        }

        let left_start = i;
        while i < bytes.len() && bytes[i].is_ascii_digit() {
            i += 1;
        }
        let left_end = i;
        let left_len = left_end - left_start;
        if left_len != 2 && left_len != 4 {
            continue;
        }

        let mut cursor = skip_ascii_spaces(bytes, i);
        if cursor >= bytes.len() || bytes[cursor] != b'/' {
            continue;
        }
        cursor += 1;
        cursor = skip_ascii_spaces(bytes, cursor);

        let left = &text[left_start..left_end];
        let start_year = resolve_start_year(left, current_year);
        let Some(start_year) = start_year else {
            continue;
        };

        let end_year = if cursor >= bytes.len() {
            Some(current_year)
        } else if bytes[cursor] == b'.' {
            while cursor < bytes.len() && bytes[cursor] == b'.' {
                cursor += 1;
            }
            Some(current_year)
        } else if starts_with_ascii_word(bytes, cursor, b"ATUAL")
            || starts_with_ascii_word(bytes, cursor, b"HOJE")
        {
            Some(current_year)
        } else if bytes[cursor].is_ascii_digit() {
            let right_start = cursor;
            while cursor < bytes.len() && bytes[cursor].is_ascii_digit() {
                cursor += 1;
            }
            let right_end = cursor;
            let right_len = right_end - right_start;
            if right_len != 2 && right_len != 4 {
                None
            } else {
                resolve_end_year(&text[right_start..right_end], start_year, current_year)
            }
        } else {
            None
        };

        if let Some(end_year) = end_year {
            if end_year >= start_year {
                ranges.push((start_year, end_year));
            }
        }
    }

    ranges
}

fn resolve_start_year(token: &str, current_year: i32) -> Option<i32> {
    match token.len() {
        2 => token
            .parse::<i32>()
            .ok()
            .map(|year| two_digit_to_year(year, current_year)),
        4 => token.parse::<i32>().ok(),
        _ => None,
    }
}

fn resolve_end_year(token: &str, start_year: i32, current_year: i32) -> Option<i32> {
    match token.len() {
        2 => {
            let mut year = two_digit_to_year(token.parse::<i32>().ok()?, current_year);
            while year < start_year {
                year += 100;
            }
            Some(year)
        }
        4 => token.parse::<i32>().ok(),
        _ => None,
    }
}

fn two_digit_to_year(year: i32, current_year: i32) -> i32 {
    let century = (current_year / 100) * 100;
    let current_short = current_year.rem_euclid(100);
    if year <= current_short {
        century + year
    } else {
        century - 100 + year
    }
}

fn skip_ascii_spaces(bytes: &[u8], mut index: usize) -> usize {
    while index < bytes.len() && bytes[index].is_ascii_whitespace() {
        index += 1;
    }
    index
}

fn starts_with_ascii_word(bytes: &[u8], index: usize, word: &[u8]) -> bool {
    bytes
        .get(index..index + word.len())
        .map(|slice| slice.eq_ignore_ascii_case(word))
        .unwrap_or(false)
}

fn push_unique(values: &mut Vec<String>, value: String) {
    if !values.iter().any(|existing| existing == &value) {
        values.push(value);
    }
}

fn unique_values(values: Vec<String>) -> Vec<String> {
    let mut out = Vec::new();
    for value in values {
        push_unique(&mut out, value);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn expands_closed_two_digit_range() {
        assert_eq!(
            vehicle_years_from_name("HILUX 05/15", 2026),
            "05,06,07,08,09,10,11,12,13,14,15,2005,2006,2007,2008,2009,2010,2011,2012,2013,2014,2015"
        );
    }

    #[test]
    fn expands_open_range_to_current_year() {
        assert!(vehicle_years_from_name("HILUX 15/...", 2026).ends_with(",2026"));
        assert!(vehicle_years_from_name("HILUX 15/...", 2026).contains("2020"));
    }

    #[test]
    fn handles_previous_century_and_cross_century_ranges() {
        assert_eq!(
            vehicle_years_from_name("ASTRA 93/95", 2026),
            "93,94,95,1993,1994,1995"
        );
        assert_eq!(
            vehicle_years_from_name("MODELO 99/01", 2026),
            "99,00,01,1999,2000,2001"
        );
    }

    #[test]
    fn builds_search_aliases() {
        assert_eq!(
            search_year_aliases("2006", 2026),
            Some(vec!["2006".to_string(), "06".to_string()])
        );
        assert_eq!(
            search_year_aliases("06", 2026),
            Some(vec!["06".to_string(), "2006".to_string()])
        );
    }
}
