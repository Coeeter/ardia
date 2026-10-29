#import "../ios/ArdiaTransferLedger.h"

#include <cstdio>
#include <thread>

static int failures = 0;
#define CHECK(cond)                                                \
  do {                                                             \
    if (!(cond)) {                                                 \
      std::printf("FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond);  \
      failures++;                                                  \
    }                                                              \
  } while (0)

static bool ClosesParked(NSInteger parkedUnder, NSInteger expired) { return parkedUnder == expired; }

int main() {
  @autoreleasepool {
    {
      ArdiaTransferLedger *ledger = [ArdiaTransferLedger new];
      const NSInteger held = [ledger holdForReload:@"t"];
      const NSInteger moved = [ledger prepare:@"t"];
      CHECK(moved != held);
      CHECK(![ledger expireReloadHold:@"t" generation:held]);
      CHECK([ledger preparedGeneration:@"t"] == moved);
    }
    {
      ArdiaTransferLedger *ledger = [ArdiaTransferLedger new];
      const NSInteger held = [ledger holdForReload:@"t"];
      CHECK([ledger expireReloadHold:@"t" generation:held]);
      CHECK(![ledger isPrepared:@"t"]);
      CHECK(![ledger expireReloadHold:@"t" generation:held]);
      const NSInteger moved = [ledger prepare:@"t"];
      const NSInteger parkedUnder = [ledger preparedGeneration:@"t"];
      CHECK(parkedUnder == moved);
      CHECK(!ClosesParked(parkedUnder, held));
    }
    {
      ArdiaTransferLedger *ledger = [ArdiaTransferLedger new];
      const NSInteger first = [ledger prepare:@"t"];
      const NSInteger parkedUnder = [ledger preparedGeneration:@"t"];
      CHECK(ClosesParked(parkedUnder, [ledger drop:@"t"]));
      const NSInteger second = [ledger prepare:@"t"];
      CHECK(!ClosesParked([ledger preparedGeneration:@"t"], first));
      CHECK([ledger drop:@"t"] == second);
    }
    {
      ArdiaTransferLedger *ledger = [ArdiaTransferLedger new];
      const NSInteger held = [ledger holdForReload:@"t"];
      [ledger drop:@"t"];
      CHECK(![ledger expireReloadHold:@"t" generation:held]);
    }
    {
      ArdiaTransferLedger *ledger = [ArdiaTransferLedger new];
      std::thread js([ledger] {
        for (int i = 0; i < 20000; i++) {
          NSString *key = i % 2 ? @"a" : @"b";
          [ledger prepare:key];
          if (i % 3 == 0) [ledger drop:key];
          [ledger isPrepared:key];
        }
      });
      int expired = 0;
      for (int i = 0; i < 20000; i++) {
        NSString *key = i % 2 ? @"b" : @"a";
        const NSInteger held = [ledger holdForReload:key];
        if ([ledger expireReloadHold:key generation:held]) expired++;
        [ledger preparedGeneration:key];
      }
      js.join();
      CHECK(expired > 0);
    }
  }
  if (failures) return 1;
  std::printf("transfer-ledger: ok\n");
  return 0;
}
