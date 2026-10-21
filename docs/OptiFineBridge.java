import java.io.File;
import java.lang.reflect.InvocationTargetException;

/**
 * LDFCL's own small adapter, not OptiFine code. Runs the downloaded official
 * installer's doInstall(File) entry point without opening Swing or relying on
 * the user's default .minecraft directory. Compatible with a Java 8 JRE.
 * Rebuild: javac --release 8 -encoding UTF-8 -d <temp> docs/OptiFineBridge.java
 * The resulting class is embedded in electron/services/optifine-bridge.ts.
 */
public final class OptiFineBridge {
    public static void main(String[] args) throws Exception {
        if (args.length != 3) throw new IllegalArgumentException("Expected staging directory, Minecraft version and OptiFine edition");
        System.setProperty("java.awt.headless", "true");
        Class<?> installer = Class.forName("optifine.Installer");
        String actual = (String) installer.getMethod("getOptiFineVersion").invoke(null);
        String expected = "OptiFine_" + args[1] + "_" + args[2];
        if (!expected.equals(actual)) throw new IllegalStateException("Installer version mismatch: expected " + expected + ", received " + actual);
        try {
            installer.getMethod("doInstall", File.class).invoke(null, new File(args[0]).getCanonicalFile());
        } catch (InvocationTargetException error) {
            throw new RuntimeException("OptiFine official installer failed", error.getCause());
        }
        System.out.println("LDFCL_OPTIFINE_INSTALLED " + actual);
    }
}
