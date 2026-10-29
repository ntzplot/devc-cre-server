from pathlib import Path

# CONFIG
BASE_DIR = Path(".")
INPUT_FILE = Path("lines.txt")
OUTPUT_NAME = "emails.csv"


def extract_lines(path: Path) -> list[str]:
    lines = []
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        lines.append(line)
    return lines


def split_evenly(items: list[str], n_parts: int) -> list[list[str]]:
    size = len(items)
    chunk = (size + n_parts - 1) // n_parts
    return [items[i * chunk:(i + 1) * chunk] for i in range(n_parts)]


def ask_folder_count() -> int:
    while True:
        raw = input("How many folders? (e.g., 2): ").strip()
        try:
            n = int(raw)
            if n > 0:
                return n
            print("Please enter a number greater than 0.")
        except ValueError:
            print("Please enter a valid integer (e.g., 2).")


def main():
    n_folders = ask_folder_count()
    folders = [str(i) for i in range(1, n_folders + 1)]

    if not INPUT_FILE.exists():
        raise FileNotFoundError(f"Missing {INPUT_FILE}")

    lines = extract_lines(INPUT_FILE)
    if not lines:
        raise ValueError("No lines found in lines.txt.")

    for f in folders:
        folder_path = BASE_DIR / f
        if not folder_path.is_dir():
            raise FileNotFoundError(f"Folder not found: {folder_path.resolve()}")

    parts = split_evenly(lines, n_folders)

    for folder, chunk in zip(folders, parts):
        out_path = BASE_DIR / folder / OUTPUT_NAME
        out_path.write_text("\n".join(chunk) + "\n", encoding="utf-8")
        print(f"Wrote {len(chunk)} line(s) -> {out_path}")

    print(f"\nDone. Distributed {len(lines)} lines across {n_folders} folder(s).")


if __name__ == "__main__":
    main()
