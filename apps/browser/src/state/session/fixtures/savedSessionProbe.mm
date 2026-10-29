#import "ArdiaSavedSession.h"
#include <cstdio>
#include <cstdlib>

static ArdiaSavedSession *Write(NSString *dir, NSDictionary *doc) {
  [[NSFileManager defaultManager] createDirectoryAtPath:dir withIntermediateDirectories:YES attributes:nil error:nil];
  [[NSJSONSerialization dataWithJSONObject:doc options:0 error:nil] writeToFile:[dir stringByAppendingPathComponent:@"session.json"] atomically:YES];
  return [ArdiaSavedSession readFrom:dir];
}

static void Check(BOOL ok, const char *what) {
  printf("%s %s\n", ok ? "ok" : "FAIL", what);
  if (!ok) exit(1);
}

int main(int argc, char **argv) {
  @autoreleasepool {
    NSString *root = [NSString stringWithUTF8String:argv[1]];
    NSDictionary *oldTab = @{ @"id" : @"a", @"pinned" : @YES, @"pinnedAsRow" : @YES };
    NSDictionary *newTab = @{ @"id" : @"a", @"pin" : @{ @"as" : @"row" } };
    for (NSNumber *v in @[ @4, @5 ]) {
      ArdiaSavedSession *s = Write([root stringByAppendingPathComponent:v.stringValue], @{ @"version" : v, @"tabs" : @[ oldTab ] });
      Check(s && s.fileVersion == v.integerValue && [[s pinOfTab:s.tabs[0]] isEqual:@YES], [NSString stringWithFormat:@"a version %@ file reads pinned", v].UTF8String);
    }
    ArdiaSavedSession *none = Write([root stringByAppendingPathComponent:@"0"], @{ @"tabs" : @[ oldTab ] });
    Check(none && none.fileVersion == 0 && [[none pinOfTab:none.tabs[0]] isEqual:@YES], "a file without a version reads pinned");
    ArdiaSavedSession *six = Write([root stringByAppendingPathComponent:@"6"], @{ @"version" : @6, @"tabs" : @[ newTab, @{ @"id" : @"b", @"pin" : NSNull.null } ] });
    Check(six && six.fileVersion == 6 && [[six pinOfTab:six.tabs[0]] isEqual:@{ @"as" : @"row" }], "a version 6 file reads pin");
    Check([[six pinOfTab:six.tabs[1]] isEqual:NSNull.null], "an unpinned version 6 tab reads null");
    Check(![[six pinOfTab:six.tabs[0]] isEqual:@YES] && [six pinOfTab:@{ @"pinned" : @YES }] == nil, "version 6 ignores the old field");
    Check(Write([root stringByAppendingPathComponent:@"newer"], @{ @"version" : @(ArdiaSavedSession.version + 1), @"tabs" : @[] }) == nil, "a newer file is refused");
  }
  return 0;
}
