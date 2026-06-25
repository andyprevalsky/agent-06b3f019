#include <node_api.h>
#include <dlfcn.h>
#include <string>
#import <Cocoa/Cocoa.h>
#import <objc/message.h>
#import <objc/runtime.h>

static id originalDelegate = nil;
static id bridgeProxy = nil;
static NSString *activityOutputPath = nil;
static IMP originalSetDelegateImplementation = NULL;
static BOOL settingDelegateFromBridge = NO;

typedef char *(*RosePasskeyImportJsonFn)(const char *);
typedef void (*RosePasskeyImportFreeFn)(char *);

static void *passkeyImportLibraryHandle = nullptr;
static RosePasskeyImportJsonFn passkeyImportJson = nullptr;
static RosePasskeyImportFreeFn passkeyImportFree = nullptr;

static BOOL RoseIsCredentialExchangeActivityType(NSString *activityType) {
  if (activityType == nil) return NO;
  return [activityType isEqualToString:@"ASCredentialExchangeActivity"] ||
         [activityType hasSuffix:@":ASCredentialExchangeActivity"];
}

static id RoseSanitizeForJSON(id value) {
  if (value == nil || value == [NSNull null]) return [NSNull null];

  if ([value isKindOfClass:[NSString class]] ||
      [value isKindOfClass:[NSNumber class]]) {
    return value;
  }

  if ([value isKindOfClass:[NSURL class]]) {
    return [(NSURL *)value absoluteString] ?: @"";
  }

  if ([value isKindOfClass:[NSUUID class]]) {
    return [(NSUUID *)value UUIDString] ?: @"";
  }

  if ([value isKindOfClass:[NSData class]]) {
    return [(NSData *)value base64EncodedStringWithOptions:0] ?: @"";
  }

  if ([value isKindOfClass:[NSDate class]]) {
    return @([(NSDate *)value timeIntervalSince1970]);
  }

  if ([value isKindOfClass:[NSArray class]]) {
    NSMutableArray *array = [NSMutableArray array];
    for (id item in (NSArray *)value) {
      [array addObject:RoseSanitizeForJSON(item)];
    }
    return array;
  }

  if ([value isKindOfClass:[NSDictionary class]]) {
    NSMutableDictionary *dict = [NSMutableDictionary dictionary];
    for (id key in (NSDictionary *)value) {
      NSString *keyString = [key isKindOfClass:[NSString class]] ? key : [key description];
      dict[keyString] = RoseSanitizeForJSON([(NSDictionary *)value objectForKey:key]);
    }
    return dict;
  }

  return [value description] ?: @"";
}

static std::string RoseCurrentAddonDirectory() {
  Dl_info info;
  if (dladdr((void *)&RoseCurrentAddonDirectory, &info) == 0 || info.dli_fname == nullptr) {
    return "";
  }

  std::string path(info.dli_fname);
  size_t slash = path.find_last_of('/');
  if (slash == std::string::npos) {
    return "";
  }
  return path.substr(0, slash);
}

static bool RoseLoadPasskeyImportLibrary(std::string *error) {
  if (passkeyImportJson != nullptr && passkeyImportFree != nullptr) {
    return true;
  }

  std::string directory = RoseCurrentAddonDirectory();
  if (directory.empty()) {
    if (error != nullptr) *error = "could not resolve native addon directory";
    return false;
  }

  std::string dylibPath = directory + "/librose_passkey_import.dylib";
  passkeyImportLibraryHandle = dlopen(dylibPath.c_str(), RTLD_NOW | RTLD_LOCAL);
  if (passkeyImportLibraryHandle == nullptr) {
    const char *dlError = dlerror();
    if (error != nullptr) {
      *error = std::string("failed to load ") + dylibPath + ": " + (dlError != nullptr ? dlError : "unknown error");
    }
    return false;
  }

  passkeyImportJson = (RosePasskeyImportJsonFn)dlsym(passkeyImportLibraryHandle, "rose_passkey_import_json");
  passkeyImportFree = (RosePasskeyImportFreeFn)dlsym(passkeyImportLibraryHandle, "rose_passkey_import_free");
  if (passkeyImportJson == nullptr || passkeyImportFree == nullptr) {
    if (error != nullptr) {
      *error = "librose_passkey_import.dylib is missing required symbols";
    }
    dlclose(passkeyImportLibraryHandle);
    passkeyImportLibraryHandle = nullptr;
    passkeyImportJson = nullptr;
    passkeyImportFree = nullptr;
    return false;
  }

  return true;
}

static void RoseWriteUserActivity(NSUserActivity *activity) {
  if (activityOutputPath == nil || activity == nil) return;

  NSMutableDictionary *payload = [NSMutableDictionary dictionary];
  payload[@"activityType"] = activity.activityType ?: @"";
  payload[@"timestamp"] = @([[NSDate date] timeIntervalSince1970]);
  payload[@"userInfo"] = RoseSanitizeForJSON(activity.userInfo ?: @{});
  if (activity.webpageURL != nil) {
    payload[@"webpageURL"] = activity.webpageURL.absoluteString ?: @"";
  }

  NSError *jsonError = nil;
  NSData *data = [NSJSONSerialization dataWithJSONObject:payload options:0 error:&jsonError];
  if (data == nil || jsonError != nil) {
    NSLog(@"[RoseUserActivityBridge] failed to encode activity: %@", jsonError);
    return;
  }

  NSString *directory = [activityOutputPath stringByDeletingLastPathComponent];
  [[NSFileManager defaultManager] createDirectoryAtPath:directory
                            withIntermediateDirectories:YES
                                             attributes:nil
                                                  error:nil];

  NSError *writeError = nil;
  if (![data writeToFile:activityOutputPath options:NSDataWritingAtomic error:&writeError]) {
    NSLog(@"[RoseUserActivityBridge] failed to write activity: %@", writeError);
  } else {
    NSLog(@"[RoseUserActivityBridge] wrote activity type=%@", activity.activityType);
  }
}

@interface RoseUserActivityDelegateProxy : NSProxy <NSApplicationDelegate>
@end

static void RoseCallOriginalSetDelegate(NSApplication *application, id delegate) {
  if (originalSetDelegateImplementation == NULL) {
    return;
  }

  void (*setDelegate)(id, SEL, id) = (void (*)(id, SEL, id))originalSetDelegateImplementation;
  settingDelegateFromBridge = YES;
  setDelegate(application, @selector(setDelegate:), delegate);
  settingDelegateFromBridge = NO;
}

static void RoseSetApplicationDelegate(id self, SEL _cmd, id delegate) {
  if (settingDelegateFromBridge || bridgeProxy == nil || delegate == bridgeProxy) {
    void (*setDelegate)(id, SEL, id) = (void (*)(id, SEL, id))originalSetDelegateImplementation;
    setDelegate(self, _cmd, delegate);
    return;
  }

  originalDelegate = delegate;
  RoseCallOriginalSetDelegate((NSApplication *)self, bridgeProxy);
}

static void RoseEnsureSetDelegateSwizzled() {
  if (originalSetDelegateImplementation != NULL) {
    return;
  }

  Method method = class_getInstanceMethod([NSApplication class], @selector(setDelegate:));
  if (method == NULL) {
    return;
  }
  originalSetDelegateImplementation = method_setImplementation(method, (IMP)RoseSetApplicationDelegate);
}

static BOOL RoseInstallDelegateProxyNow() {
  NSApplication *application = [NSApplication sharedApplication];
  if (bridgeProxy == nil) {
    bridgeProxy = [RoseUserActivityDelegateProxy alloc];
  }

  RoseEnsureSetDelegateSwizzled();

  id currentDelegate = application.delegate;
  if (currentDelegate == nil) {
    // During early Electron startup the app delegate may not exist yet. Arm the
    // setDelegate: swizzle, but do not install the proxy as the only delegate or
    // Electron can miss applicationDidFinishLaunching and never become ready.
    return originalSetDelegateImplementation != NULL;
  }
  if (currentDelegate != bridgeProxy) {
    originalDelegate = currentDelegate;
    RoseCallOriginalSetDelegate(application, bridgeProxy);
  }

  return application.delegate == bridgeProxy;
}

@implementation RoseUserActivityDelegateProxy

- (BOOL)application:(NSApplication *)application willContinueUserActivityWithType:(NSString *)userActivityType {
  NSLog(@"[RoseUserActivityBridge] willContinueUserActivityWithType=%@", userActivityType);
  BOOL isCredentialExchange = RoseIsCredentialExchangeActivityType(userActivityType);
  if (originalDelegate != nil &&
      [originalDelegate respondsToSelector:@selector(application:willContinueUserActivityWithType:)]) {
    BOOL (*msgSend)(id, SEL, NSApplication *, NSString *) =
      (BOOL (*)(id, SEL, NSApplication *, NSString *))objc_msgSend;
    BOOL originalHandled =
      msgSend(originalDelegate, @selector(application:willContinueUserActivityWithType:), application, userActivityType);
    return originalHandled || isCredentialExchange;
  }
  return YES;
}

- (BOOL)application:(NSApplication *)application
continueUserActivity:(NSUserActivity *)userActivity
 restorationHandler:(void (^)(NSArray<id<NSUserActivityRestoring>> *restorableObjects))restorationHandler {
  NSLog(@"[RoseUserActivityBridge] continueUserActivity type=%@", userActivity.activityType);
  BOOL isCredentialExchange = RoseIsCredentialExchangeActivityType(userActivity.activityType);
  if (isCredentialExchange) {
    RoseWriteUserActivity(userActivity);
  }

  if (originalDelegate != nil &&
      [originalDelegate respondsToSelector:@selector(application:continueUserActivity:restorationHandler:)]) {
    BOOL (*msgSend)(id, SEL, NSApplication *, NSUserActivity *, void (^)(NSArray<id<NSUserActivityRestoring>> *)) =
      (BOOL (*)(id, SEL, NSApplication *, NSUserActivity *, void (^)(NSArray<id<NSUserActivityRestoring>> *)))objc_msgSend;
    BOOL handled = msgSend(originalDelegate,
                           @selector(application:continueUserActivity:restorationHandler:),
                           application,
                           userActivity,
                           restorationHandler);
    return handled || isCredentialExchange;
  }

  return isCredentialExchange;
}

- (void)application:(NSApplication *)application
didFailToContinueUserActivityWithType:(NSString *)userActivityType
              error:(NSError *)error {
  NSLog(@"[RoseUserActivityBridge] didFailToContinueUserActivityWithType=%@ error=%@", userActivityType, error);
  if (originalDelegate != nil &&
      [originalDelegate respondsToSelector:@selector(application:didFailToContinueUserActivityWithType:error:)]) {
    void (*msgSend)(id, SEL, NSApplication *, NSString *, NSError *) =
      (void (*)(id, SEL, NSApplication *, NSString *, NSError *))objc_msgSend;
    msgSend(originalDelegate,
            @selector(application:didFailToContinueUserActivityWithType:error:),
            application,
            userActivityType,
            error);
  }
}

- (BOOL)respondsToSelector:(SEL)aSelector {
  if (aSelector == @selector(application:willContinueUserActivityWithType:) ||
      aSelector == @selector(application:continueUserActivity:restorationHandler:) ||
      aSelector == @selector(application:didFailToContinueUserActivityWithType:error:)) {
    return YES;
  }
  return originalDelegate != nil && [originalDelegate respondsToSelector:aSelector];
}

- (NSMethodSignature *)methodSignatureForSelector:(SEL)selector {
  NSMethodSignature *signature = nil;
  if (originalDelegate != nil) {
    signature = [originalDelegate methodSignatureForSelector:selector];
  }
  if (signature != nil) return signature;
  return [NSObject instanceMethodSignatureForSelector:@selector(init)];
}

- (void)forwardInvocation:(NSInvocation *)invocation {
  if (originalDelegate != nil && [originalDelegate respondsToSelector:invocation.selector]) {
    [invocation invokeWithTarget:originalDelegate];
  }
}

@end

static napi_value Install(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "install(outputPath) requires a path");
    return nullptr;
  }

  size_t length = 0;
  napi_get_value_string_utf8(env, args[0], nullptr, 0, &length);
  std::string path(length + 1, '\0');
  napi_get_value_string_utf8(env, args[0], path.data(), path.size(), &length);
  path.resize(length);

  activityOutputPath = [[NSString alloc] initWithUTF8String:path.c_str()];

  __block BOOL installed = NO;
  void (^installBlock)(void) = ^{
    installed = RoseInstallDelegateProxyNow();
    NSLog(@"[RoseUserActivityBridge] installed=%@ output=%@",
          installed ? @"YES" : @"NO",
          activityOutputPath);
  };

  if ([NSThread isMainThread]) {
    installBlock();
  } else {
    dispatch_sync(dispatch_get_main_queue(), installBlock);
  }

  napi_value result;
  napi_get_boolean(env, installed, &result);
  return result;
}

static napi_value ImportCredentials(napi_env env, napi_callback_info info) {
  size_t argc = 1;
  napi_value args[1];
  napi_get_cb_info(env, info, &argc, args, nullptr, nullptr);

  if (argc < 1) {
    napi_throw_type_error(env, nullptr, "importCredentials(token) requires a token");
    return nullptr;
  }

  size_t length = 0;
  napi_get_value_string_utf8(env, args[0], nullptr, 0, &length);
  std::string token(length + 1, '\0');
  napi_get_value_string_utf8(env, args[0], token.data(), token.size(), &length);
  token.resize(length);

  std::string loadError;
  if (!RoseLoadPasskeyImportLibrary(&loadError)) {
    napi_throw_error(env, nullptr, loadError.c_str());
    return nullptr;
  }

  char *json = passkeyImportJson(token.c_str());
  if (json == nullptr) {
    napi_throw_error(env, nullptr, "passkey import returned no response");
    return nullptr;
  }

  napi_value result;
  napi_status status = napi_create_string_utf8(env, json, NAPI_AUTO_LENGTH, &result);
  passkeyImportFree(json);
  if (status != napi_ok) {
    napi_throw_error(env, nullptr, "failed to convert passkey import response");
    return nullptr;
  }
  return result;
}

static napi_value Init(napi_env env, napi_value exports) {
  napi_property_descriptor descriptors[] = {
    {"install", nullptr, Install, nullptr, nullptr, nullptr, napi_default, nullptr},
    {"importCredentials", nullptr, ImportCredentials, nullptr, nullptr, nullptr, napi_default, nullptr},
  };
  napi_define_properties(env, exports, 2, descriptors);
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, Init)
