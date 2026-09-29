#ifdef VARIANT_TWO
int feature(void)
#else
int feature(int value)
#endif
{
#ifdef VARIANT_TWO
    return 2;
#else
    return value;
#endif
}

int invoke(void) {
#ifdef VARIANT_TWO
    return feature();
#else
    return /* 汉字 */ feature(1);
#endif
}

int only_declaration(void);
