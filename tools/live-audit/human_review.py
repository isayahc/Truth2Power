"""Record an actual human review decision without giving models an approval tool."""
import argparse
from full_review import record_human_decision
from server import DATA, save


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("result_file")
    parser.add_argument("--decision", choices=["approve", "reject", "needs_changes"], required=True)
    parser.add_argument("--reviewer-role", required=True, help="Role label, not a person's name")
    parser.add_argument("--notes", required=True)
    parser.add_argument("--confirm-human-review", action="store_true", required=True)
    args = parser.parse_args()
    print(record_human_decision(args.result_file, args.decision, args.reviewer_role, args.notes, DATA, save))
