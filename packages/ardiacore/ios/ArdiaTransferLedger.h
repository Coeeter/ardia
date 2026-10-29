#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ArdiaTransferLedger : NSObject

- (NSInteger)prepare:(NSString *)key;
- (NSInteger)holdForReload:(NSString *)key;
- (BOOL)isPrepared:(NSString *)key;
- (NSInteger)preparedGeneration:(NSString *)key;
- (NSInteger)drop:(NSString *)key;
- (BOOL)expireReloadHold:(NSString *)key generation:(NSInteger)generation;

@end

NS_ASSUME_NONNULL_END
