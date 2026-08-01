Total, average or rank rows of data -- a CSV, a TSV, a pasted table. Read this before doing arithmetic over more than a couple of rows.

Do not add the rows up yourself. Put them in a file and let a script do it.

1. write_file the rows verbatim to data.csv. Do not retype a figure, reorder a
   column, or drop the header.
2. write_file a summarise.py that reads data.csv with the csv module and prints
   one line per figure you were asked for.
3. bash: python3 summarise.py
4. Report only numbers that appeared in its output.

If exit_code is not 0, fix the script and run it again. Never fall back to
working the answer out in your head -- that is the mistake this procedure exists
to prevent.

Round money in the script, to two places, rather than in the sentence you write.
