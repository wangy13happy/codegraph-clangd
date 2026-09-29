#ifdef VARIANT_TWO
static int helper(void) { return 2; }
#else
static int helper(void) { return 1; }
#endif

int use_helper(void) { return helper(); }
