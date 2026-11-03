#include <stdio.h>
#include <stdlib.h>
#include <locale.h>
#include <sys/types.h>

int strvis(char *, const char *, int);

/* one hex-encoded string per line; 0x08 | 0x10 | 0x40 is VIS_TAB | VIS_NL | VIS_NOSLASH, as Apple's ps */
int main(void) {
  char *line = NULL;
  size_t cap = 0;
  ssize_t n;
  setlocale(LC_ALL, "");
  while ((n = getline(&line, &cap, stdin)) >= 0) {
    if (n && line[n - 1] == '\n') line[--n] = 0;
    char *raw = malloc(n / 2 + 1);
    size_t k = 0;
    for (ssize_t i = 0; i + 1 < n; i += 2) {
      unsigned v;
      sscanf(line + i, "%2x", &v);
      raw[k++] = (char)v;
    }
    raw[k] = 0;
    char *out = malloc(k * 4 + 1);
    strvis(out, raw, 0x08 | 0x10 | 0x40);
    fputs(out, stdout);
    fputc('\n', stdout);
    free(raw);
    free(out);
  }
  return 0;
}
